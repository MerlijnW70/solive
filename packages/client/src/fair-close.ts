import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { IntentStatus, InvalidInput, SdkError } from "@intent-engine/core";
import {
  buildMigrate,
  buildRequestCancel,
  buildSettleClaims,
  CANCEL_NOTICE_SECS,
  CLAIM_BOARD_DISCRIMINATOR,
  type ClaimBoard,
  claimBoardAddress,
  claimListAddress,
  CLAIMS_OPEN,
  DELIVERY_BOOK_DISCRIMINATOR,
  deliveryBookAddress,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import { chainTime, createdAccount } from "./accounts.js";
import { NotSettleable } from "./client-errors.js";
import { reviewOf, type ReviewView } from "./client-claims.js";
import type { ClientContext } from "./client-types.js";
import { isOldBook, readBoard, readBook } from "./fair-reads.js";
import { type IntentRef, loadIntentRef } from "./intent-ref.js";
import { type Plan, planOf } from "./plan.js";
import type { Transport } from "./transport.js";

export type CancelStage = "now" | "request" | "notice" | "review";

export type CancelState = {
  intent: Address;
  stage: CancelStage;
  announced: boolean;
  cancelAt: bigint | null;
  review: ReviewView | null;
  readyAt: bigint | null;
  secondsLeft: bigint;
  migrates: boolean;
};

export const NOTICE_SECS = CANCEL_NOTICE_SECS;

const NONE = "11111111111111111111111111111111" as Address;

export const cancelNotReadyText = (state: CancelState): string => {
  if (state.stage === "request") {
    return `has an announcement, so its owner first requests a cancel; the cancel can land ${NOTICE_SECS} seconds after the request`;
  }
  if (state.stage === "notice") {
    return `has a cancel notice running until ${state.readyAt}, ${state.secondsLeft} more seconds; a release can still pay the work until then`;
  }
  if (state.stage === "review") {
    return `has the delivery ${state.review?.announcement ?? ""} under review by the judge until ${state.readyAt}, ${state.secondsLeft} more seconds; a cancel then pays the holder its stake and the kill fee`;
  }
  return "can be cancelled now";
};

export class CancelNotReady extends SdkError {
  readonly code = "cancel-not-ready";
  override readonly name = "CancelNotReady";
  readonly intent: Address;
  readonly stage: CancelStage;
  readonly readyAt: bigint | null;

  constructor(state: CancelState, text = cancelNotReadyText(state)) {
    super(`intent ${state.intent} ${text}`);
    this.intent = state.intent;
    this.stage = state.stage;
    this.readyAt = state.readyAt;
  }
}

type Book = { cancelAt: bigint; migrates: boolean } | null;

async function bookOf(transport: Transport, intent: Address): Promise<Book> {
  const view = await createdAccount(transport, await deliveryBookAddress(intent));
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !DELIVERY_BOOK_DISCRIMINATOR.every((b, i) => view.data[i] === b)) {
    return null;
  }
  return { cancelAt: readBook(view.data).cancelAt, migrates: isOldBook(view.data) };
}

export async function boardOf(transport: Transport, intent: Address, claims: number): Promise<ClaimBoard | null> {
  if (claims !== CLAIMS_OPEN) {
    return null;
  }
  const view = await createdAccount(transport, await claimBoardAddress(intent));
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !CLAIM_BOARD_DISCRIMINATOR.every((b, i) => view.data[i] === b)) {
    return null;
  }
  try {
    return readBoard(view.data);
  } catch {
    return null;
  }
}

export function cancelStateOf(intent: Address, book: Book, board: ClaimBoard | null, now: bigint): CancelState {
  const review = board === null ? null : reviewOf(board, now);
  const pending = review !== null && !review.lapsed ? review.until : null;
  const cancelAt = book === null || book.cancelAt === 0n ? null : book.cancelAt;
  const base = { intent, announced: book !== null, cancelAt, review, migrates: book?.migrates ?? false };
  if (book !== null && cancelAt === null) {
    return { ...base, stage: "request", readyAt: null, secondsLeft: 0n };
  }
  const waits = [cancelAt, pending].filter((at): at is bigint => at !== null && at > now);
  if (waits.length === 0) {
    return { ...base, stage: "now", readyAt: null, secondsLeft: 0n };
  }
  const readyAt = waits.reduce((a, b) => (a > b ? a : b));
  return { ...base, stage: cancelAt !== null && cancelAt > now ? "notice" : "review", readyAt, secondsLeft: readyAt - now };
}

export async function cancelStateAt(transport: Transport, intent: Address, claims: number, open = true): Promise<CancelState> {
  if (!open) {
    return cancelStateOf(intent, null, null, 0n);
  }
  const [book, board, now] = await Promise.all([bookOf(transport, intent), boardOf(transport, intent, claims), chainTime(transport)]);
  return cancelStateOf(intent, book, board, now);
}

export async function cancelState(transport: Transport, ref: IntentRef): Promise<CancelState> {
  const { address, intent } = await loadIntentRef(transport, ref);
  return cancelStateAt(transport, address, intent.claims, intent.status === IntentStatus.Open);
}

export const notOwnerRequest = (intent: Address, owner: Address, signer: Address): string =>
  `intent ${intent} belongs to ${owner}, and only its owner requests its cancel, not ${signer}`;

export async function requestCancelInstructions(transport: Transport, owner: TransactionSigner, intent: Address, state: CancelState): Promise<Instruction[]> {
  if (state.stage !== "request") {
    throw new CancelNotReady(state, state.announced ? `already has a cancel requested; ${cancelNotReadyText(state)}` : "has no announcement, so it is cancelled at once and needs no request");
  }
  const migrate = state.migrates ? [await buildMigrate({ payer: owner, account: await deliveryBookAddress(intent) })] : [];
  return [...migrate, await buildRequestCancel({ owner, intent })];
}

export function requestCancelPlan({ transport }: ClientContext) {
  return async (signer: TransactionSigner, ref: IntentRef): Promise<Plan> => {
    const { address, intent } = await loadIntentRef(transport, ref);
    if (intent.owner !== signer.address) {
      throw new InvalidInput("signer", "conflict", notOwnerRequest(address, intent.owner, signer.address));
    }
    const state = await cancelStateAt(transport, address, intent.claims, intent.status === IntentStatus.Open);
    return planOf({ payer: signer.address, instructions: await requestCancelInstructions(transport, signer, address, state) });
  };
}

export type Collectable = { intent: Address; owner: Address; worker: Address; announcement: Address; reviewUntil: bigint; stake: bigint; killFee: bigint; listed: boolean };

export async function collectable(transport: Transport, ref: IntentRef): Promise<Collectable> {
  const { address, intent } = await loadIntentRef(transport, ref);
  const board = await boardOf(transport, address, intent.claims);
  const now = await chainTime(transport);
  const review = board === null ? null : reviewOf(board, now);
  if (board === null || review === null || board.worker === NONE) {
    throw new NotSettleable(address, "no-review", "has no armed review, so there is no kill fee to collect");
  }
  if (!review.lapsed) {
    throw new NotSettleable(address, "review-running", `has its review running until ${review.until}, ${review.secondsLeft} more seconds; collect once it ends without a release or reject`);
  }
  return { intent: address, owner: board.owner, worker: board.worker, announcement: review.announcement, reviewUntil: review.until, stake: board.held, killFee: board.killFee, listed: board.listed !== 0 };
}

export async function collectInstruction(found: Collectable): Promise<Instruction> {
  return buildSettleClaims({ intent: found.intent, owner: found.owner, worker: found.worker, ...(found.listed ? { claimList: await claimListAddress(found.intent) } : {}) });
}

export function collectPlan({ transport }: ClientContext) {
  return async (payer: TransactionSigner, ref: IntentRef): Promise<Plan & Collectable> => {
    const found = await collectable(transport, ref);
    return { ...planOf({ payer: payer.address, instructions: [await collectInstruction(found)] }), ...found };
  };
}
