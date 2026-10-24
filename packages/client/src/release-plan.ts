import { type Address, createNoopSigner, getAddressDecoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { announcementCommitment, decodeParams, IntentStatus, InvalidInput, isSaltHex, Kind, splitFees } from "@intent-engine/core";
import { chainTime, createdAccount, SYSTEM_PROGRAM_ADDRESS } from "./accounts.js";
import { sha256Bytes } from "./announce.js";
import { loadAnnouncement } from "./announcement-reads.js";
import { releaseClaims } from "./client-claims.js";
import { EscrowExpired, NotSettleable, PayeeMoved, PayToNotWallet } from "./client-errors.js";
import type { ClientContext, ReleaseOpening } from "./client-types.js";
import { type IntentRef, loadIntentRef } from "./intent-ref.js";
import { hex } from "./job-proofs.js";
import { tokenAccountIfMissing } from "./setup.js";

export type ReleaseTarget = {
  intent: IntentRef;
  announcement: Address;
  opening: ReleaseOpening;
  result: bigint;
  payer?: TransactionSigner | undefined;
};

export type Judged<J> = { feeOwner: Address; judge: J };

export function saltBytes(salt: string): Uint8Array {
  const lowered = salt.trim().toLowerCase();
  if (!isSaltHex(lowered)) {
    throw new InvalidInput("salt", "format", "an opening's salt must be 32 hex digits");
  }
  return Uint8Array.from(Buffer.from(lowered, "hex"));
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

async function announced(context: ClientContext, intent: Address, target: ReleaseTarget) {
  const delivered = sha256Bytes(target.opening.sha256);
  const salt = saltBytes(target.opening.salt);
  const found = await loadAnnouncement(context.transport, target.announcement);
  if (found === null) {
    throw new NotSettleable(intent, "unknown-announcement", `has no announcement ${target.announcement}; nothing was sent`);
  }
  if (found.intent !== intent) {
    throw new NotSettleable(intent, "other-escrow", `is not the escrow of the announcement ${target.announcement}, which belongs to ${found.intent}; nothing was sent`);
  }
  if (found.state !== "announced") {
    throw new NotSettleable(intent, "already-paid", `already paid the announcement ${target.announcement}; nothing was sent`);
  }
  if (!equal(await announcementCommitment(intent, found.worker, { delivered, salt }), found.commitment)) {
    throw new NotSettleable(intent, "salt-mismatch", `holds the announcement ${target.announcement}, which this salt does not open to the work ${hex(delivered)}; nothing was sent`);
  }
  return { found, delivered, salt };
}

export async function checkWallet(context: ClientContext, wallet: Address): Promise<void> {
  const holder = await context.transport.getAccount(wallet);
  if (holder !== null && holder.owner !== SYSTEM_PROGRAM_ADDRESS) {
    throw new PayToNotWallet(wallet, holder.owner);
  }
}

export async function releaseBasis<J>(
  context: ClientContext,
  target: ReleaseTarget,
  payees: (worker: Address) => readonly Address[],
  judgeOf: (attestor: Address, intent: Address) => Promise<Judged<J>>,
) {
  const { transport, mint, config } = context;
  const { result } = target;
  const [{ address, intent: held }, settings] = await Promise.all([loadIntentRef(transport, target.intent), config()]);
  const payer = target.payer ?? createNoopSigner(held.owner);
  const { owner, nonce } = held;
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  if (params.kind !== Kind.AttestedResult) {
    throw new NotSettleable(address, "not-attested", "is not an AttestedResult intent");
  }
  if (params.specHash.every((b) => b === 0)) {
    throw new NotSettleable(address, "not-a-proof-escrow", "commits no spec hash, so it is not a proof intent");
  }
  if (held.status !== IntentStatus.Open) {
    throw new NotSettleable(address, "not-open", "is not open");
  }
  const { feeOwner, judge } = await judgeOf(params.attestor, address);
  if (held.expiresAt <= (await chainTime(transport))) {
    throw new EscrowExpired(address, held.expiresAt);
  }
  const { found, delivered, salt } = await announced(context, address, target);
  const wallets = payees(found.worker);
  for (const wallet of wallets) {
    await checkWallet(context, wallet);
  }
  const { accounts: claims } = await releaseClaims(transport, address, held.claims, wallets);
  const { tokenProgram } = await mint(held.inputMint);
  const account = (wallet: Address) => tokenAccountIfMissing(transport, payer, wallet, held.inputMint, tokenProgram);
  const amountIn = held.escrowed - held.filled;
  const kindBps = held.feeBps;
  const maxFeeBps = kindBps + held.partnerBps;
  const shares = splitFees(amountIn - params.judgeFee, kindBps, held.partnerBps, held.partnerCutBps);
  const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
  const partner = shares.partner > 0n ? held.partner : undefined;
  const paidJudge = params.judgeFee > 0n ? feeOwner : undefined;
  const others = await Promise.all([feeRecipient, partner, paidJudge].filter((wallet) => wallet !== undefined).map(account));
  const fields = { amountIn, result, maxFeeBps };
  const opening = { delivered, salt };
  return {
    intent: address,
    judge,
    worker: found.worker,
    account,
    tokenProgram,
    terms: {
      ...fields,
      domain: Uint8Array.from(settings.domain),
      intent: address,
      filled: held.filled,
      revision: held.revision,
      specHash: params.specHash,
      announcement: found.address,
      seq: found.seq,
      ...opening,
    },
    fill: {
      ...fields,
      owner,
      nonce,
      inputMint: held.inputMint,
      inputTokenProgram: tokenProgram,
      capped: held.capped,
      announcement: found.address,
      opening,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(paidJudge === undefined ? {} : { judge: paidJudge }),
    },
    setup: others.flatMap(({ create }): Instruction[] => create),
    claims,
  };
}

export async function planRelease<J>(context: ClientContext, target: ReleaseTarget, judgeOf: (attestor: Address, intent: Address) => Promise<Judged<J>>) {
  const basis = await releaseBasis(context, target, (worker) => [worker], judgeOf);
  const payee = await basis.account(basis.worker);
  if (payee.create.length === 0) {
    const existing = await createdAccount(context.transport, payee.address);
    const data = existing === null || existing.owner !== basis.tokenProgram || existing.data.length < 64 ? null : existing.data;
    if (
      data === null ||
      getAddressDecoder().decode(data.subarray(0, 32)) !== basis.fill.inputMint ||
      getAddressDecoder().decode(data.subarray(32, 64)) !== basis.worker
    ) {
      throw new PayeeMoved(basis.worker, payee.address);
    }
  }
  return {
    ...basis,
    proof: { ...basis.terms, payee: payee.address },
    fill: { ...basis.fill, payee: payee.address },
    setup: [...payee.create, ...basis.setup],
  };
}
