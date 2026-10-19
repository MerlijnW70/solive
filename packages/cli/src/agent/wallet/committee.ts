import { createHash } from "node:crypto";
import { type Address, getBase16Decoder } from "@solana/kit";
import { committeeEnvelope, releaseMemo } from "@intent-engine/core";
import { type CommitteeBallot, createClient, deliveryRecord, firstDelivery, NotSettleable, VoteRejected } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletKeypair } from "./guard.js";
import { openingOutput, openingsFor, sealedRecord, sendOpenings } from "./openings.js";
import { ATTEST_PAGES, DELIVERED_NEEDED, HISTORY_TOO_LONG, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, notEarliest, confirmedRelease } from "./delivery.js";
import { RELEASE_CHANGED } from "./attest.js";

export const VOTE_CHANGED = "this vote differs from its preview: the escrow, payee, result or delivered work changed, or no approval was given; preview it again and show the user";

export const NOT_A_MEMBER = "this server's wallet is not a member of the committee this escrow names, so it has no vote";

const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

const ballotInput = {
  owner: account("the wallet that made the escrow"),
  nonce: amount("the escrow intent's nonce"),
  pay_to: account("the wallet the release pays"),
  result: amount("the result the release attests, between the intent's min_result and max_result"),
  delivered_sha256: text("the sha256, as 64 hex digits, of the work the release pays for; its earliest announcer must be pay_to"),
  max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
};

type BallotArgs = { owner: Address; nonce: bigint; pay_to: Address; result: bigint; delivered_sha256: string; max_pages?: number | undefined };

async function ballotOf(ctx: AgentContext, input: BallotArgs) {
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const target = { owner: input.owner, nonce: input.nonce, payTo: input.pay_to, result: input.result };
  let ballot: CommitteeBallot;
  try {
    ballot = await client.committeeBallot(target);
  } catch (error) {
    if (error instanceof NotSettleable) {
      throw new AgentRefusal("KindMismatch", error.message);
    }
    throw error;
  }
  const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
  const keypair = await walletKeypair(ctx);
  const record = await deliveryRecord(ctx.transport, ballot.committee.address, ballot.intent, input.max_pages ?? ATTEST_PAGES, keypair);
  if (!record.complete) {
    throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
  }
  sealedRecord(record, keypair);
  const first = firstDelivery(record.deliveries, delivered);
  if (first !== null && first.worker !== input.pay_to) {
    throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
  }
  const confirmed = { intent: ballot.intent, attestor: ballot.committee.address, sha256: delivered, pages: input.max_pages ?? ATTEST_PAGES, payees: [input.pay_to], keypair };
  await confirmedRelease(ctx, confirmed);
  return { client, target, ballot, delivered, salt: first?.salt, openings: openingsFor(record, first) };
}

const ballotApproval = (ballot: CommitteeBallot, delivered: string, salt: string | undefined) =>
  createHash("sha256").update(ballot.digest).update(releaseMemo(delivered, salt)).digest("hex").slice(0, 16);

const ballotLines = (ballot: CommitteeBallot, input: BallotArgs, delivered: string) => [
  `Releases: escrow ${ballot.intent} to ${input.pay_to} with result ${input.result}`,
  `Pays for: the work with sha256 ${delivered}`,
  `Judged by: committee ${ballot.committee.address}, any ${ballot.committee.threshold} of its ${ballot.committee.members.length} members`,
];

export const walletCommitteeVote = define({
  name: tool("wallet_committee_vote"),
  title: "Vote on a release as a committee member",
  description: `Casts this wallet's vote, as a member of an escrow's judging committee, that the escrow pays pay_to for the work with delivered_sha256. Judge the work against the spec yourself first. The vote is signed, not sent: once enough members vote, anyone submits the votes with ${tool("wallet_committee_release")}. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    ...ballotInput,
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the vote; leave out to preview")),
  }),
  output: object({
    intent: account(),
    committee: account(),
    approval: text(),
    summary: list(text(), 8),
    signed: flag(),
    vote: optional(object({ member: account(), signature: text("the member's ed25519 signature as 128 hex digits") })),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input) => {
    const signer = await signerOf(ctx);
    const { ballot, delivered, salt } = await ballotOf(ctx, input);
    if (!ballot.committee.members.includes(signer.address)) {
      throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
    }
    const approval = ballotApproval(ballot, delivered, salt);
    const shown = { intent: ballot.intent, committee: ballot.committee.address, approval, summary: ballotLines(ballot, input, delivered) };
    if (input.send !== true) {
      return { ...shown, signed: false, next: `call again with send: true and this approval to sign the vote, then pass it to ${tool("wallet_committee_release")}` };
    }
    if (input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", VOTE_CHANGED);
    }
    const signature = await signer.signBytes(committeeEnvelope(ballot.digest, ballot.committee.members));
    return { ...shown, signed: true, vote: { member: signer.address, signature: hex(signature) } };
  },
});

export const walletCommitteeRelease = define({
  name: tool("wallet_committee_release"),
  title: "Release an escrow on its committee's votes",
  description: `Pays a worker once a judging committee agrees: submits the members' votes from ${tool("wallet_committee_vote")} to release the escrow, and records the delivered work's sha256. Every vote is checked before sending, and the release needs at least the committee's threshold of votes. This wallet pays the fee. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    ...ballotInput,
    votes: list(object({ member: account(), signature: text("the member's ed25519 signature as 128 hex digits") }), 8, "one vote per member, in any order", 1),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true submits the release; leave out to preview")),
  }),
  output: object({
    intent: account(),
    committee: account(),
    signers: list(account(), 8),
    approval: text(),
    ...openingOutput,
    summary: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, target, ballot, delivered, salt, openings } = await ballotOf(ctx, input);
    const votes = input.votes.map((vote, i) => {
      if (!/^[0-9a-fA-F]{128}$/.test(vote.signature)) {
        throw new InvalidInput([{ path: `votes.${i}.signature`, message: "give the signature as 128 hex digits" }]);
      }
      return { member: vote.member, signature: Uint8Array.from(Buffer.from(vote.signature, "hex")) };
    });
    let release;
    try {
      release = await client.prepareCommitteeRelease({ ...target, solver: signer, votes, deliveredSha256: delivered, ...(salt === undefined ? {} : { deliveredSalt: salt }) });
    } catch (error) {
      if (error instanceof VoteRejected) {
        throw new AgentRefusal("SigMessage", error.message);
      }
      throw error;
    }
    const approval = ballotApproval(ballot, delivered, salt);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    if (input.send === true && release.setup.length > 0) {
      await ctx.transport.send(release.setup, signer);
    }
    const prepared = input.send === true ? preparedView(await prepare(ctx.transport, release.instructions, signer.address)) : undefined;
    const view = {
      intent: release.intent,
      committee: release.committee.address,
      signers: release.signers,
      approval,
      summary: [
        ...ballotLines(ballot, input, delivered),
        `Signed by: ${release.signers.length} of its members, ${release.signers.join(", ")}`,
        `Pays the fee: this server's wallet ${signer.address}`,
      ],
      prepared,
    };
    const done = await sent(ctx, signer, view, input.send, call, {
      preview: PREVIEW_APPROVAL_NEXT,
      done: `release sent; ${tool("wallet_feedback")} to rate if you own it`,
    });
    return "signature" in done ? { ...done, ...(await sendOpenings(ctx, signer, ballot.committee.address, openings)) } : done;
  },
});
