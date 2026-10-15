import type { Address, TransactionSigner } from "@solana/kit";
import {
  findBoardPda,
  getClaimJobInstructionAsync,
  getDropClaimInstructionAsync,
  getOpenClaimsInstructionAsync,
  getSettleClaimsInstructionAsync,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { IntentCoreError } from "./errors.js";

export const CLAIMS_OPEN = 1;
export const MAX_CLAIM_SECS = 7 * 24 * 60 * 60;
export const MAX_CLAIM_STAKE = 100_000_000_000n;

const NONE = "11111111111111111111111111111111" as Address;

export type ClaimSlot =
  | { state: "free" }
  | { state: "held"; worker: Address; until: bigint }
  | { state: "lapsed"; worker: Address };

export type BoardView = { owner: Address; worker: Address; until: bigint; held: bigint };

export function claimSlot(board: Pick<BoardView, "worker" | "until">, now: bigint): ClaimSlot {
  if (board.worker === NONE) return { state: "free" };
  return now < board.until ? { state: "held", worker: board.worker, until: board.until } : { state: "lapsed", worker: board.worker };
}

export function checkClaimTerms(maxSecs: number, stake: bigint): void {
  if (!Number.isInteger(maxSecs) || maxSecs < 1 || maxSecs > MAX_CLAIM_SECS || stake < 0n || stake > MAX_CLAIM_STAKE) {
    throw new IntentCoreError("ClaimTerms");
  }
}

export function claimUntil(maxSecs: number, now: bigint, secs: number, expiresAt: bigint): bigint {
  if (!Number.isInteger(secs) || secs < 1 || secs > maxSecs) throw new IntentCoreError("ClaimTerms");
  const until = now + BigInt(secs);
  if (until > expiresAt) throw new IntentCoreError("ClaimTerms");
  return until;
}

export function stakeReceiverOnRelease(board: BoardView, now: bigint, payees: readonly Address[]): Address | null {
  const slot = claimSlot(board, now);
  if (slot.state === "free") return null;
  if (slot.state === "held") {
    if (!payees.includes(slot.worker)) throw new IntentCoreError("ClaimHeld");
    return slot.worker;
  }
  return payees.includes(slot.worker) ? slot.worker : board.owner;
}

export function stakeReceiverOnSettle(board: BoardView, now: bigint, escrowOpen: boolean): Address | null {
  const slot = claimSlot(board, now);
  if (slot.state === "free") return null;
  if (slot.state === "held") {
    if (escrowOpen) throw new IntentCoreError("ClaimHeld");
    return slot.worker;
  }
  return board.owner;
}

export async function claimBoardAddress(intent: Address): Promise<Address> {
  return (await findBoardPda({ intent }))[0];
}

export async function buildOpenClaims(input: { owner: TransactionSigner; intent: Address; maxSecs: number; stake: bigint }) {
  checkClaimTerms(input.maxSecs, input.stake);
  return getOpenClaimsInstructionAsync({ ...input, ...(await events()) });
}

export async function buildClaimJob(input: { worker: TransactionSigner; intent: Address; owner: Address; secs: number }) {
  return getClaimJobInstructionAsync({ ...input, ...(await events()) });
}

export async function buildDropClaim(input: { worker: TransactionSigner; intent: Address }) {
  return getDropClaimInstructionAsync({ ...input, ...(await events()) });
}

export async function buildSettleClaims(input: { intent: Address; owner: Address; worker?: Address }) {
  return getSettleClaimsInstructionAsync({
    intent: input.intent,
    owner: input.owner,
    ...(input.worker === undefined ? {} : { worker: input.worker }),
    ...(await events()),
  });
}
