import { inspect } from "node:util";
import { type Address, createSolanaRpcSubscriptions, type Signature } from "@solana/kit";
import { isSdkError } from "@intent-engine/core";
import { socketUrl } from "./intent-notifications.js";
import { patiently, POLL_MS, sleep } from "./rpc-retry.js";
import type { RpcLike, Status } from "./rpc-shapes.js";
import { BlockhashExpired, FailedOnChain, type Failure, failure, MaybeSent, type SendStatus, SubscriptionEnded } from "./send-errors.js";

export const CONFIRM_POLLS = 360;

export type Confirmed = { slot?: bigint };

export type SignatureWatch = (signature: Signature, signal: AbortSignal) => Promise<Confirmed | void>;

export function signatureWatch(url: string): SignatureWatch {
  const subscriptions = createSolanaRpcSubscriptions(socketUrl(url));
  return async (signature, abortSignal) => {
    const notes = await subscriptions.signatureNotifications(signature, { commitment: "confirmed" }).subscribe({ abortSignal });
    for await (const note of notes) {
      if (settles(note)) {
        return heardSlot(signature, note);
      }
    }
    throw new SubscriptionEnded(signature, "ended");
  };
}

const settles = (note: unknown): note is { context?: { slot?: unknown }; value: { err: unknown } } => {
  const value = (note as { value?: unknown } | null)?.value;
  return typeof value === "object" && value !== null && "err" in value;
};

export function heardSlot(signature: Signature, note: unknown): Confirmed {
  if (!settles(note)) {
    throw new SubscriptionEnded(signature, "no-result");
  }
  const { context, value } = note;
  const err = value.err ?? null;
  if (err !== null) {
    throw failedOnChain(failure(signature, err));
  }
  return typeof context?.slot === "bigint" ? { slot: context.slot } : {};
}

export const failedOnChain = (found: Failure): FailedOnChain => new FailedOnChain(`transaction ${found.signature} failed: ${inspect(found.err)}`, found);

export async function failureRead(rpc: RpcLike, signature: Signature, err: unknown): Promise<Failure> {
  const tx = await (async () => rpc.getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send())().catch(
    () => null,
  );
  const keys: readonly Address[] = tx?.transaction.message.accountKeys ?? [];
  const programs = (tx?.transaction.message.instructions ?? []).flatMap((ix) => keys[ix.programIdIndex] ?? []);
  const logs = tx?.meta?.logMessages ?? undefined;
  return failure(signature, err, logs === null ? undefined : logs, programs);
}

const failedRead = async (rpc: RpcLike, signature: Signature, err: unknown): Promise<FailedOnChain> => failedOnChain(await failureRead(rpc, signature, err));

const never = new Promise<Confirmed>(() => undefined);

export async function confirm(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void> = sleep,
  watch?: SignatureWatch,
): Promise<Confirmed> {
  if (watch === undefined) {
    return polled(rpc, signature, lastValidBlockHeight, wait);
  }
  const controller = new AbortController();
  const heard = watch(signature, controller.signal).then(
    (found) => found ?? {},
    async (error: unknown): Promise<Confirmed> => {
      if (isSdkError(error, "failed-on-chain")) {
        throw await failedRead(rpc, signature, error.err);
      }
      if (isSdkError(error, "maybe-sent")) {
        throw error;
      }
      return never;
    },
  );
  try {
    return await Promise.race([heard, polled(rpc, signature, lastValidBlockHeight, wait, controller.signal)]);
  } finally {
    controller.abort();
  }
}

async function settled(rpc: RpcLike, signature: Signature, status: Status | null | undefined): Promise<Confirmed | null> {
  if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
    return null;
  }
  if (status.err !== null) {
    throw await failedRead(rpc, signature, status.err);
  }
  return status.slot === undefined ? {} : { slot: status.slot };
}

export async function confirmSent(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void> = sleep,
  watch?: SignatureWatch,
): Promise<Confirmed> {
  try {
    return await confirm(rpc, signature, lastValidBlockHeight, wait, watch);
  } catch (error) {
    if (isSdkError(error, "maybe-sent") || isSdkError(error, "failed-on-chain") || isSdkError(error, "blockhash-expired")) {
      throw error;
    }
    throw new MaybeSent(
      signature,
      lastValidBlockHeight,
      `transaction ${signature} was sent but its confirmation could not be read (${error instanceof Error ? error.message : String(error)}); look the signature up before sending again`,
      { cause: error },
    );
  }
}

async function polled(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight: bigint,
  wait: (ms: number) => Promise<void>,
  stop?: AbortSignal,
): Promise<Confirmed> {
  for (let poll = 1; stop?.aborted !== true; poll++) {
    const [status] = (await patiently(() => rpc.getSignatureStatuses([signature]).send(), wait)).value;
    const confirmed = await settled(rpc, signature, status);
    if (confirmed !== null) {
      return confirmed;
    }
    const epoch = await patiently(() => rpc.getEpochInfo().send(), wait);
    if (epoch.blockHeight > lastValidBlockHeight) {
      const late = await patiently(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(), wait);
      const [found] = late.value;
      const landed = await settled(rpc, signature, found);
      if (landed !== null) {
        return landed;
      }
      if (found) {
        throw new MaybeSent(signature, lastValidBlockHeight, `transaction ${signature} landed but is not confirmed yet; look the signature up before sending again`);
      }
      if (late.context.slot >= epoch.absoluteSlot) {
        throw new BlockhashExpired(`transaction ${signature} expired before confirmation`);
      }
    }
    if (poll >= CONFIRM_POLLS) {
      throw new MaybeSent(
        signature,
        lastValidBlockHeight,
        `transaction ${signature} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
      );
    }
    await wait(POLL_MS);
  }
  return {};
}

export async function signatureStatus(
  rpc: RpcLike,
  signature: Signature,
  lastValidBlockHeight?: bigint,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<SendStatus> {
  const epoch = lastValidBlockHeight === undefined ? undefined : await patiently(() => rpc.getEpochInfo().send(), wait);
  const late = await patiently(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(), wait);
  const [found] = late.value;
  if (found && (found.confirmationStatus === "confirmed" || found.confirmationStatus === "finalized")) {
    if (found.err === null) {
      return { status: "confirmed", signature, ...(found.slot === undefined ? {} : { slot: found.slot }) };
    }
    return { status: "failed", ...(await failureRead(rpc, signature, found.err)) };
  }
  const expired =
    epoch !== undefined && lastValidBlockHeight !== undefined && epoch.blockHeight > lastValidBlockHeight && late.context.slot >= epoch.absoluteSlot;
  return !found && expired ? { status: "expired", signature } : { status: "pending", signature };
}
