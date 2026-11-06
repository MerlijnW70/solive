import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import type { RejectBallot } from "@intent-engine/client";

export const DEFAULT_REVIEW_SECS = 86_400;

const sol = (lamports: bigint): string => `${formatAmount(lamports, 9)} SOL`;

export const claimsAfterDelivery = (intent: Address): string =>
  `work was already announced to escrow ${intent}, and claims open only before the first announcement, so a claimant could not lock earlier announcers out; nothing was sent`;

export const reviewPastExpiry = (intent: Address, secs: number, reviewSecs: number, expiresAt: bigint): string =>
  `a claim of ${secs} seconds leaves escrow ${intent}, which expires at ${expiresAt}, no whole review window of ${reviewSecs} seconds after it; pass a lower --secs; nothing was sent`;

export const reviewLine = (reviewSecs: number, killFee: bigint): string =>
  reviewSecs === 0
    ? "Review: none; a delivery arms no review, so after a cancel request and its notice the owner can cancel even while work waits for the judge"
    : `Review: the judge has ${reviewSecs} seconds after the holder's first delivery to release or reject it, and the owner cannot cancel until then; if the judge does neither, the holder collects its stake and the kill fee of ${sol(killFee)}, which the owner locks on the claims board and gets back otherwise`;

export const rejectLines = (ballot: RejectBallot, sha256: string): string[] => [
  `Rejects: the delivery announced in ${ballot.announcement} (seq ${ballot.seq}) by ${ballot.worker} to escrow ${ballot.intent}, the work with sha256 ${sha256}; it can never be paid`,
  ballot.review === null
    ? "Review: none was armed for this announcement, so no stake moves"
    : `Ends: the review that runs until ${ballot.review.until}, in time, so no kill fee is owed; the holder ${ballot.worker} gets its stake back and may not claim the job again before its claim would have ended`,
  ballot.committee === null ? `Signs: as the escrow's judge ${ballot.attestor}` : `Judged by: committee ${ballot.attestor}, ${ballot.committee.threshold} of ${ballot.committee.members.length} members must sign`,
  "Keeps: the escrow open; the judge can still release a later delivery, and the owner can cancel",
];

export type Lapse = { intent: string; worker: string; announcement: string; reviewUntil: bigint; stake: bigint; killFee: bigint };

export const collectLines = (found: Lapse): string[] => [
  `Collects: the stake of ${sol(found.stake)} and the kill fee of ${sol(found.killFee)} for ${found.worker}, whose delivery ${found.announcement} to escrow ${found.intent} the judge neither released nor rejected by ${found.reviewUntil}`,
  "Frees: the claim; the escrow stays open, and a later release still pays",
];
