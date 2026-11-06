import type { Address } from "@solana/kit";
import type { ClaimsView } from "./client-claims.js";

export type ReviewBoard = { reviewSecs: number; killFee: bigint; stake: bigint; reviewUntil: bigint; reviewAnn: Address; worker: Address; until: bigint };

export type Protection = {
  reviewSecs: number;
  killFee: bigint;
  stake: bigint;
  arms: boolean;
  armBy: bigint | null;
  reviewUntil: bigint | null;
  why: string | null;
  cancelAt: bigint | null;
};

const NONE = "11111111111111111111111111111111" as Address;

export const reviewBoardOf = (view: ClaimsView): ReviewBoard => ({
  reviewSecs: view.reviewSecs,
  killFee: view.killFee,
  stake: view.stake,
  reviewUntil: view.review?.until ?? 0n,
  reviewAnn: view.review?.announcement ?? NONE,
  worker: view.worker ?? NONE,
  until: view.until,
});

export const NO_CLAIMS_UNPROTECTED =
  "the escrow takes no claims, so no announcement arms a review: once a cancel request's notice ends its owner can cancel, and a judge who stays silent pays no kill fee";

export const NO_REVIEW_UNPROTECTED =
  "the escrow's claims open no review window, so no announcement arms a review: once a cancel request's notice ends its owner can cancel, and a judge who stays silent pays no kill fee";

export const reviewArmedFor = (announcement: Address): string => `a review is armed already, for the announcement ${announcement}; this announcement arms none`;

export const NOT_HOLDER = "only the live holder of the claim arms a review, and this wallet does not hold it";

export const tooLateToArm = (armBy: bigint, reviewSecs: number): string =>
  `a review of ${reviewSecs} seconds arms only for an announcement made by ${armBy}, so the judge has the whole window before the escrow expires`;

const armByOf = (board: ReviewBoard, expiresAt: bigint): bigint | null => (board.reviewSecs === 0 ? null : expiresAt - BigInt(board.reviewSecs));

const unprotected = (board: ReviewBoard | null, cancelAt: bigint | null, why: string, armBy: bigint | null): Protection => ({
  reviewSecs: board?.reviewSecs ?? 0,
  killFee: board?.killFee ?? 0n,
  stake: board?.stake ?? 0n,
  arms: false,
  armBy,
  reviewUntil: null,
  why,
  cancelAt,
});

export function announceProtection(board: ReviewBoard | null, worker: Address, expiresAt: bigint, now: bigint, cancelAt: bigint | null): Protection {
  if (board === null) {
    return unprotected(null, cancelAt, NO_CLAIMS_UNPROTECTED, null);
  }
  const armBy = armByOf(board, expiresAt);
  if (armBy === null) {
    return unprotected(board, cancelAt, NO_REVIEW_UNPROTECTED, null);
  }
  if (board.reviewUntil !== 0n && board.worker !== NONE) {
    return unprotected(board, cancelAt, reviewArmedFor(board.reviewAnn), armBy);
  }
  if (board.worker !== worker || now >= board.until) {
    return unprotected(board, cancelAt, NOT_HOLDER, armBy);
  }
  if (now > armBy) {
    return unprotected(board, cancelAt, tooLateToArm(armBy, board.reviewSecs), armBy);
  }
  return { reviewSecs: board.reviewSecs, killFee: board.killFee, stake: board.stake, arms: true, armBy, reviewUntil: now + BigInt(board.reviewSecs), why: null, cancelAt };
}

export function claimProtection(board: ReviewBoard, expiresAt: bigint, until: bigint, cancelAt: bigint | null): Protection {
  const armBy = armByOf(board, expiresAt);
  if (armBy === null) {
    return unprotected(board, cancelAt, NO_REVIEW_UNPROTECTED, null);
  }
  const by = until < armBy ? until : armBy;
  return { reviewSecs: board.reviewSecs, killFee: board.killFee, stake: board.stake, arms: true, armBy: by, reviewUntil: null, why: null, cancelAt };
}

export const protectionLines = (p: Protection, sol: (lamports: bigint) => string): string[] => {
  if (!p.arms) {
    return [`Unprotected: ${p.why ?? NO_REVIEW_UNPROTECTED}`];
  }
  const fee = p.killFee === 0n ? "no kill fee" : `a kill fee of ${sol(p.killFee)}`;
  const window = `the judge has ${p.reviewSecs} seconds to release or reject; if it does neither, the holder collects its stake of ${sol(p.stake)} and ${fee}, and the owner cannot cancel until then`;
  return p.reviewUntil === null
    ? [`Protected: an announcement by ${p.armBy} while this claim is held arms a review; ${window}`]
    : [`Protected: this announcement arms a review until ${p.reviewUntil}; ${window}`];
};
