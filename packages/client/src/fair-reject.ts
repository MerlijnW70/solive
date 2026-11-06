import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { type CommitteeVote, IntentStatus } from "@intent-engine/core";
import {
  buildCommitteeBatch,
  buildEd25519Instruction,
  buildRejectDelivery,
  claimBoardAddress,
  COMMITTEE_COSIGN_TAG,
  committeeSigners,
  offchainEnvelope,
  rejectDeliveryPreimage,
  signMessageBytes,
  verifyCommitteeVote,
} from "@intent-engine/core/internal";
import { chainTime } from "./accounts.js";
import { loadAnnouncement } from "./announcement-reads.js";
import { reviewOf, type ReviewView } from "./client-claims.js";
import { loadCommittee, quorumOf } from "./client-committee.js";
import { NotSettleable, VoteRejected } from "./client-errors.js";
import type { ClientContext, CommitteeView, MessageSigner } from "./client-types.js";
import { boardOf } from "./fair-close.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { proofAt } from "./job-proofs.js";
import { type Plan, planOf } from "./plan.js";

export type RejectTarget = { intent: IntentRef; announcement: Address };

export type RejectBallot = {
  intent: Address;
  announcement: Address;
  seq: bigint;
  worker: Address;
  attestor: Address;
  committee: CommitteeView | null;
  review: ReviewView | null;
  digest: Uint8Array;
  message: Uint8Array;
};

export type RejectInput = RejectTarget & { judge: MessageSigner; payer?: TransactionSigner };

export type RejectCommitteeInput = RejectTarget & { relayer: TransactionSigner; votes: readonly CommitteeVote[] };

export type RejectPlan = Plan & { intent: Address; announcement: Address; worker: Address; review: ReviewView | null; voters: Address[] };

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));

const tagged = (tag: Uint8Array, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
};

export function rejectBallotOf({ transport, config }: ClientContext) {
  return async (input: RejectTarget): Promise<RejectBallot & { board: Address | null; stakeTo: Address | null }> => {
    const intent = await intentAddress(input.intent);
    const [proof, announcement, now, settings] = await Promise.all([proofAt(transport, intent), loadAnnouncement(transport, input.announcement), chainTime(transport), config()]);
    if (proof === null) {
      throw new NotSettleable(intent, "not-a-proof-escrow", "is not a proof escrow, so it has no delivery to reject");
    }
    if (proof.intent.status !== IntentStatus.Open || now >= proof.intent.expiresAt) {
      throw new NotSettleable(intent, "not-open", "is no longer open, so a delivery to it can no longer be rejected");
    }
    if (announcement === null || announcement.intent !== intent) {
      throw new NotSettleable(intent, "unknown-announcement", `has no announcement ${input.announcement}`);
    }
    if (announcement.state !== "announced") {
      throw new NotSettleable(intent, "already-paid", `has the announcement ${input.announcement} ${announcement.state} already, so it cannot be rejected`);
    }
    const attestor = proof.params.attestor;
    const committee = await loadCommittee(transport, attestor);
    const board = await boardOf(transport, intent, proof.intent.claims);
    const review = board !== null && board.reviewAnn === input.announcement ? reviewOf(board, now) : null;
    if (review?.lapsed === true) {
      throw new NotSettleable(intent, "review-lapsed", `has the review of ${input.announcement} ended at ${review.until}, so it can no longer be rejected; the holder collects its stake and the kill fee`);
    }
    const preimage = rejectDeliveryPreimage({ domain: Uint8Array.from(settings.domain), intent, announcement: input.announcement, seq: announcement.seq });
    const digest = committee === null ? await sha256(preimage) : await sha256(tagged(COMMITTEE_COSIGN_TAG, preimage));
    return {
      intent,
      announcement: input.announcement,
      seq: announcement.seq,
      worker: announcement.worker,
      attestor,
      committee,
      review,
      digest,
      message: offchainEnvelope(attestor, digest),
      board: board === null ? null : await claimBoardAddress(intent),
      stakeTo: review === null ? null : (board?.worker ?? null),
    };
  };
}

type Ballot = Awaited<ReturnType<ReturnType<typeof rejectBallotOf>>>;

async function rejectInstruction(ballot: Ballot, mask: number): Promise<Instruction> {
  return buildRejectDelivery({
    intent: ballot.intent,
    announcement: ballot.announcement,
    attestor: ballot.attestor,
    committee: ballot.committee !== null,
    signersMask: mask,
    ...(ballot.board === null ? {} : { claims: ballot.board }),
    ...(ballot.stakeTo === null ? {} : { stakeTo: ballot.stakeTo }),
  });
}

const planned = (ballot: Ballot, payer: Address, instructions: Instruction[], voters: Address[]): RejectPlan => ({
  ...planOf({ payer, instructions }),
  intent: ballot.intent,
  announcement: ballot.announcement,
  worker: ballot.worker,
  review: ballot.review,
  voters,
});

export function rejectPlans(context: ClientContext) {
  const ballotOf = rejectBallotOf(context);

  const reject = async (input: RejectInput): Promise<RejectPlan> => {
    const ballot = await ballotOf(input);
    if (ballot.committee !== null) {
      throw new NotSettleable(ballot.intent, "committee-judged", `names committee ${ballot.attestor} as its judge, so its members sign reject votes, not this reject`);
    }
    if (ballot.attestor !== input.judge.address) {
      throw new NotSettleable(ballot.intent, "wrong-judge", `names ${ballot.attestor} as its judge, not ${input.judge.address}`);
    }
    const signature = await signMessageBytes(input.judge, ballot.message);
    const verify = buildEd25519Instruction({ publicKey: input.judge.address, signature, message: ballot.message });
    return planned(ballot, (input.payer ?? input.judge).address, [verify, await rejectInstruction(ballot, 0)], [input.judge.address]);
  };

  const rejectCommittee = async (input: RejectCommitteeInput): Promise<RejectPlan> => {
    const ballot = await ballotOf(input);
    const committee = ballot.committee;
    if (committee === null) {
      throw new NotSettleable(ballot.intent, "not-a-committee", `names ${ballot.attestor} as its judge, which is not a committee`);
    }
    for (const vote of input.votes) {
      if (!(await verifyCommitteeVote(vote, ballot.digest, committee.members))) {
        throw new VoteRejected(vote.member, ballot.intent);
      }
    }
    const { instruction, mask } = buildCommitteeBatch(committee, ballot.digest, quorumOf(committee, input.votes));
    return planned(ballot, input.relayer.address, [instruction, await rejectInstruction(ballot, mask)], committeeSigners(committee, mask));
  };

  const rejectBallot = async (input: RejectTarget): Promise<RejectBallot> => {
    const { board: _board, stakeTo: _stakeTo, ...ballot } = await ballotOf(input);
    return ballot;
  };

  return { reject, rejectCommittee, rejectBallot };
}
