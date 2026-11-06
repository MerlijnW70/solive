import type { Address, TransactionSigner } from "@solana/kit";
import {
  findBoardPda,
  findEntryPda,
  getAdvanceInstructionAsync,
  getClaimJobInstructionAsync,
  getDropClaimInstructionAsync,
  getLeaveInstructionAsync,
  getOpenClaimsInstructionAsync,
  getSettleClaimsInstructionAsync,
  getStandByInstructionAsync,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { findDeliveryBookPda } from "./pdas.js";
import { type CoreErrorCode, IntentCoreError, InvalidInput } from "./errors.js";

export const CLAIMS_OPEN = 1;
export const MAX_CLAIM_SECS = 7 * 24 * 60 * 60;
export const MAX_CLAIM_STAKE = 100_000_000_000n;
export const MIN_CLAIM_STAKE = 890_880n;
export const MAX_LINE_ENTRIES = 4;
export const MAX_LINE_SEQ = 0xffff_fffe;
export const MIN_REVIEW_SECS = 3_600;
export const MAX_REVIEW_SECS = MAX_CLAIM_SECS;
export const MAX_KILL_FEE = MAX_CLAIM_STAKE;
export const CANCEL_NOTICE_SECS = 86_400n;
const HELD_FOR_REVIEW = 0x7fff_ffff_ffff_ffffn;

const NONE = "11111111111111111111111111111111" as Address;

export type ClaimSlot =
  | { state: "free" }
  | { state: "held"; worker: Address; until: bigint }
  | { state: "lapsed"; worker: Address };

export type BoardView = { owner: Address; worker: Address; until: bigint; held: bigint; droppedBy?: Address; head?: number; tail?: number; reviewUntil?: bigint; killFee?: bigint; reviewSecs?: number };

type SlotView = Pick<BoardView, "worker" | "until" | "reviewUntil">;

export type LineView = Pick<BoardView, "head" | "tail">;

export function lineLength(line: LineView): number {
  return Math.max(0, (line.tail ?? 0) - (line.head ?? 0));
}

export function lineSeqs(line: LineView, max = MAX_LINE_ENTRIES): number[] {
  const head = line.head ?? 0;
  return Array.from({ length: Math.min(lineLength(line), max) }, (_, i) => head + i);
}

export function boardViewArmed(board: SlotView): boolean {
  return board.worker !== NONE && (board.reviewUntil ?? 0n) !== 0n;
}

export function claimSlot(board: SlotView, now: bigint): ClaimSlot {
  if (board.worker === NONE) return { state: "free" };
  if (boardViewArmed(board)) return { state: "held", worker: board.worker, until: HELD_FOR_REVIEW };
  return now < board.until ? { state: "held", worker: board.worker, until: board.until } : { state: "lapsed", worker: board.worker };
}

export function claimCooldown(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "droppedBy">, now: bigint): { worker: Address; until: bigint } | null {
  const dropped = board.droppedBy ?? NONE;
  return claimSlot(board, now).state === "free" && dropped !== NONE && now < board.until ? { worker: dropped, until: board.until } : null;
}

export function checkClaimant(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "droppedBy" | "head" | "tail">, claimant: Address, now: bigint): void {
  if (lineLength(board) > 0) throw new IntentCoreError("LineWaiting");
  if (claimSlot(board, now).state === "held") throw new IntentCoreError("ClaimHeld");
  if (claimCooldown(board, now)?.worker === claimant) throw new IntentCoreError("ClaimCooldown");
}

export function takeUntil(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "reviewSecs" | "droppedBy" | "head" | "tail">, claimant: Address, terms: { maxSecs: number; secs: number; expiresAt: bigint }, now: bigint): bigint {
  checkClaimant(board, claimant, now);
  const until = claimUntil(terms.maxSecs, now, terms.secs, terms.expiresAt);
  if (until + BigInt(board.reviewSecs ?? 0) > terms.expiresAt) throw new IntentCoreError("ReviewPastExpiry");
  return until;
}

export function standByRefusal(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "head" | "tail">, claimant: Address, secs: number, maxSecs: number, now: bigint): CoreErrorCode | "HolderStandsBy" | undefined {
  if (!Number.isInteger(secs) || secs < 1 || secs > maxSecs) return "ClaimTerms";
  const slot = claimSlot(board, now);
  if (slot.state === "held" && slot.worker === claimant) return "HolderStandsBy";
  return slot.state !== "held" && lineLength(board) === 0 ? "JobNotHeld" : undefined;
}

export function checkStandBy(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "head" | "tail">, now: bigint): void {
  if (claimSlot(board, now).state !== "held" && lineLength(board) === 0) throw new IntentCoreError("JobNotHeld");
}

export function checkAdvance(board: Pick<BoardView, "worker" | "until" | "reviewUntil" | "head" | "tail">, now: bigint): void {
  if (claimSlot(board, now).state === "held") throw new IntentCoreError("ClaimHeld");
  if (lineLength(board) === 0) throw new IntentCoreError("LineEmpty");
}

export function checkClaimTerms(maxSecs: number, stake: bigint): void {
  if (!Number.isInteger(maxSecs) || maxSecs < 1 || maxSecs > MAX_CLAIM_SECS || stake < 0n || stake > MAX_CLAIM_STAKE) {
    throw new IntentCoreError("ClaimTerms");
  }
}

export function stakeBelowRent(floor?: string): string {
  const least = floor === undefined ? "the rent-exempt minimum of an empty account on this cluster" : `${floor}, the rent-exempt minimum of an empty account on this cluster`;
  return `a claim stake is 0 or at least ${least}, so the program can always pay a stake back to a wallet that holds nothing`;
}

export function checkClaimStake(stake: bigint, floor: bigint = MIN_CLAIM_STAKE): void {
  if (stake > 0n && stake < floor) {
    throw new InvalidInput("stake", "range", `StakeBelowRent: ${stakeBelowRent(`${floor} lamports`)}`);
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
  return board.owner;
}

export function stakeReceiverOnCancel(board: BoardView, now: bigint): Address | null {
  if (boardViewArmed(board) && now < (board.reviewUntil ?? 0n)) throw new IntentCoreError("ReviewPending");
  const slot = claimSlot(board, now);
  if (slot.state === "free") return null;
  return slot.state === "held" ? slot.worker : board.owner;
}

export function stakeReceiverOnSettle(board: BoardView, now: bigint, escrowOpen: boolean): Address | null {
  if (boardViewArmed(board) && (!escrowOpen || now >= (board.reviewUntil ?? 0n))) return board.worker;
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

export type ReviewTermsInput = { reviewSecs?: number | undefined; killFee?: bigint | undefined };

export function checkReviewTerms(reviewSecs: number, killFee: bigint, stake: bigint, floor: bigint = MIN_CLAIM_STAKE): void {
  const secsOk = reviewSecs === 0 || (Number.isInteger(reviewSecs) && reviewSecs >= MIN_REVIEW_SECS && reviewSecs <= MAX_REVIEW_SECS);
  if (!secsOk || (killFee !== 0n && (reviewSecs === 0 || stake === 0n)) || killFee < 0n || killFee > MAX_KILL_FEE) {
    throw new IntentCoreError("ReviewTerms");
  }
  if (killFee !== 0n && killFee < floor) {
    throw new InvalidInput("killFee", "range", `StakeBelowRent: a kill fee is 0 or at least ${floor} lamports`);
  }
}

export function reviewTerms(input: ReviewTermsInput & { stake: bigint; floor?: bigint | undefined }): { reviewSecs: number; killFee: bigint } {
  const reviewSecs = input.reviewSecs ?? 0;
  const killFee = input.killFee ?? 0n;
  checkReviewTerms(reviewSecs, killFee, input.stake, input.floor);
  return { reviewSecs, killFee };
}

export async function buildOpenClaims(input: { owner: TransactionSigner; intent: Address; maxSecs: number; stake: bigint; floor?: bigint | undefined } & ReviewTermsInput) {
  const { floor, reviewSecs, killFee, ...terms } = input;
  checkClaimTerms(terms.maxSecs, terms.stake);
  checkClaimStake(terms.stake, floor);
  const review = reviewTerms({ reviewSecs, killFee, stake: terms.stake, floor });
  const book = (await findDeliveryBookPda({ intent: terms.intent }))[0];
  return getOpenClaimsInstructionAsync({ ...terms, ...review, book, ...(await events()) });
}

const listed = (claimList: Address | undefined) => (claimList === undefined ? {} : { claimList });

export async function buildClaimJob(input: { worker: TransactionSigner; intent: Address; owner: Address; secs: number; claimList?: Address | undefined }) {
  const { claimList, ...rest } = input;
  return getClaimJobInstructionAsync({ ...rest, ...listed(claimList), ...(await events()) });
}

export async function standbyAddress(intent: Address, seq: number): Promise<Address> {
  return (await findEntryPda({ intent, seq }))[0];
}

export type LineHandover = { entries: readonly Address[]; nextWorker?: Address; dropper?: Address; refunded?: number };

function entryAccounts(entries: readonly Address[]) {
  if (entries.length > MAX_LINE_ENTRIES) throw new IntentCoreError("InvalidParams");
  const [entry0, entry1, entry2, entry3] = entries;
  return {
    ...(entry0 === undefined ? {} : { entry0 }),
    ...(entry1 === undefined ? {} : { entry1 }),
    ...(entry2 === undefined ? {} : { entry2 }),
    ...(entry3 === undefined ? {} : { entry3 }),
  };
}

export async function buildDropClaim(input: { worker: TransactionSigner; intent: Address } & Partial<LineHandover>) {
  const { worker, intent, entries = [], nextWorker } = input;
  return getDropClaimInstructionAsync({ worker, intent, ...(nextWorker === undefined ? {} : { nextWorker }), ...entryAccounts(entries), ...(await events()) });
}

export async function buildStandBy(input: { worker: TransactionSigner; intent: Address; seq: number; secs: number; claimList?: Address | undefined }) {
  const entry = await standbyAddress(input.intent, input.seq);
  return getStandByInstructionAsync({ worker: input.worker, intent: input.intent, entry, secs: input.secs, ...listed(input.claimList), ...(await events()) });
}

export async function buildAdvance(input: { intent: Address; owner: Address } & LineHandover) {
  return getAdvanceInstructionAsync({
    intent: input.intent,
    owner: input.owner,
    ...(input.nextWorker === undefined ? {} : { nextWorker: input.nextWorker }),
    ...entryAccounts(input.entries),
    ...(input.dropper === undefined ? {} : { dropper: input.dropper }),
    ...(await events()),
  });
}

export async function buildLeave(input: { caller: TransactionSigner; intent: Address; seq: number; worker: Address }) {
  return getLeaveInstructionAsync({ ...input, ...(await events()) });
}

export async function buildSettleClaims(input: { intent: Address; owner: Address; worker?: Address; claimList?: Address | undefined }) {
  return getSettleClaimsInstructionAsync({
    intent: input.intent,
    owner: input.owner,
    ...(input.worker === undefined ? {} : { worker: input.worker }),
    ...listed(input.claimList),
    ...(await events()),
  });
}
