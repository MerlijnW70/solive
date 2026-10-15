import { createHash } from "node:crypto";
import { type Address, getBase16Decoder } from "@solana/kit";
import { releaseMemo, signCommitteeVote } from "@intent-engine/core";
import { type CommitteeBallot, createClient, deliveryRecord, firstDelivery, NotSettleable, VoteRejected } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { signerOf, sent, sha256Of } from "./guard.js";
import { ATTEST_PAGES, DELIVERED_NEEDED, HISTORY_TOO_LONG, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, notEarliest } from "./delivery.js";
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
  const record = await deliveryRecord(ctx.transport, ballot.committee.address, ballot.intent, input.max_pages ?? ATTEST_PAGES);
  if (!record.complete) {
    throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
  }
  const first = firstDelivery(record.deliveries, delivered);
  if (first !== null && first.worker !== input.pay_to) {
    throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
  }
  return { client, target, ballot, delivered };
}

const ballotApproval = (ballot: CommitteeBallot, delivered: string) =>
  createHash("sha256").update(ballot.digest).update(releaseMemo(delivered)).digest("hex").slice(0, 16);

const ballotLines = (ballot: CommitteeBallot, input: BallotArgs, delivered: string) => [
  `Releases: escrow ${ballot.intent} to ${input.pay_to} with result ${input.result}`,
  `Pays for: the work with sha256 ${delivered}`,
  `Judged by: committee ${ballot.committee.address}, any ${ballot.committee.threshold} of its ${ballot.committee.members.length} members`,
];

export const walletCommitteeVote = define({
  name: tool("wallet_committee_vote"),
  title: "Vote on a release as a committee member",
  description: `As one member of the committee an escrow names, sign this server's vote that the escrow pays pay_to for the work with delivered_sha256. Nothing is sent: the release needs votes from the committee's threshold of members, which anyone then submits with ${tool("wallet_committee_release")}. Vote only after judging the work against the escrow's spec yourself. Without send it only previews and signs nothing; show the user the summary and, once they approve, call again with send: true and the approval the preview returned.`,
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
    const { ballot, delivered } = await ballotOf(ctx, input);
    if (!ballot.committee.members.includes(signer.address)) {
      throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
    }
    const approval = ballotApproval(ballot, delivered);
    const shown = { intent: ballot.intent, committee: ballot.committee.address, approval, summary: ballotLines(ballot, input, delivered) };
    if (input.send !== true) {
      return { ...shown, signed: false, next: `call again with send: true and this approval to sign the vote, then pass it to ${tool("wallet_committee_release")}` };
    }
    if (input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", VOTE_CHANGED);
    }
    const vote = await signCommitteeVote(signer, ballot.digest);
    return { ...shown, signed: true, vote: { member: vote.member, signature: hex(vote.signature) } };
  },
});

export const walletCommitteeRelease = define({
  name: tool("wallet_committee_release"),
  title: "Release an escrow on its committee's votes",
  description: `Submit the votes of a committee's members, gathered with ${tool("wallet_committee_vote")}, to release the escrow that names the committee; this server's wallet pays the fee and records the delivered work's sha256. Every vote is checked before anything is sent, and the release needs at least the committee's threshold of them. Without send it only previews; show the user the summary and, once they approve, call again with send: true and the approval the preview returned.`,
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
    summary: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, target, ballot, delivered } = await ballotOf(ctx, input);
    const votes = input.votes.map((vote, i) => {
      if (!/^[0-9a-fA-F]{128}$/.test(vote.signature)) {
        throw new InvalidInput([{ path: `votes.${i}.signature`, message: "give the signature as 128 hex digits" }]);
      }
      return { member: vote.member, signature: Uint8Array.from(Buffer.from(vote.signature, "hex")) };
    });
    let release;
    try {
      release = await client.prepareCommitteeRelease({ ...target, solver: signer, votes, deliveredSha256: delivered });
    } catch (error) {
      if (error instanceof VoteRejected) {
        throw new AgentRefusal("SigMessage", error.message);
      }
      throw error;
    }
    const approval = ballotApproval(ballot, delivered);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
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
    return sent(ctx, signer, view, input.send, call);
  },
});
