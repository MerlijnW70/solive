import { inspect } from "node:util";
import { createSolanaRpcSubscriptions, type Signature } from "@solana/kit";
import { socketUrl } from "./intent-notifications.js";
import { BlockhashExpired, Charged, FailedOnChain, patiently, POLL_MS, sleep } from "./rpc-retry.js";
import type { RpcLike, Status } from "./rpc-shapes.js";

export const CONFIRM_POLLS = 360;

export type Confirmed = { slot?: bigint };

export type SignatureWatch = (signature: Signature, signal: AbortSignal) => Promise<Confirmed | void>;

export function signatureWatch(url: string): SignatureWatch {
  const subscriptions = createSolanaRpcSubscriptions(socketUrl(url));
  return async (signature, abortSignal) => {
    const notes = await subscriptions.signatureNotifications(signature, { commitment: "confirmed" }).subscribe({ abortSignal });
    const iterator = notes[Symbol.asyncIterator]();
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error(`the signature subscription for ${signature} ended without a notification`);
    }
    return heardSlot(signature, next.value);
  };
}

export function heardSlot(signature: Signature, note: unknown): Confirmed {
  const { context, value } = (note ?? {}) as { context?: { slot?: unknown }; value?: { err?: unknown } };
  const err = value?.err ?? null;
  if (err !== null) {
    throw new FailedOnChain(`transaction ${signature} failed: ${inspect(err)}`);
  }
  return typeof context?.slot === "bigint" ? { slot: context.slot } : {};
}

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
    (error: unknown) => {
      if (error instanceof Charged) {
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

function settled(signature: Signature, status: Status | null | undefined): Confirmed | null {
  if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) {
    return null;
  }
  if (status.err !== null) {
    throw new FailedOnChain(`transaction ${signature} failed: ${inspect(status.err)}`);
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
    if (error instanceof Charged || error instanceof BlockhashExpired) {
      throw error;
    }
    throw new Charged(
      `transaction ${signature} was sent but its confirmation could not be read (${error instanceof Error ? error.message : String(error)}); look the signature up before sending again`,
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
    const confirmed = settled(signature, status);
    if (confirmed !== null) {
      return confirmed;
    }
    const epoch = await patiently(() => rpc.getEpochInfo().send(), wait);
    if (epoch.blockHeight > lastValidBlockHeight) {
      const late = await patiently(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(), wait);
      const [found] = late.value;
      const landed = settled(signature, found);
      if (landed !== null) {
        return landed;
      }
      if (found) {
        throw new Charged(`transaction ${signature} landed but is not confirmed yet; look the signature up before sending again`);
      }
      if (late.context.slot >= epoch.absoluteSlot) {
        throw new BlockhashExpired(`transaction ${signature} expired before confirmation`);
      }
    }
    if (poll >= CONFIRM_POLLS) {
      throw new Charged(
        `transaction ${signature} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
      );
    }
    await wait(POLL_MS);
  }
  return {};
}
