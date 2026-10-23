import { createHash } from "node:crypto";
import { type Address, getBase16Decoder } from "@solana/kit";
import { buildCreateCommittee, committeeEnvelope, getCommitteeSize, IntentCoreError, MAX_COMMITTEE_MEMBERS, MAX_COMMITTEE_THRESHOLD, releaseMemo } from "@intent-engine/core";
import { ClaimHeldBy, type CommitteeBallot, createClient, deliveryRecord, firstDelivery, NotSettleable, VoteRejected } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal, ENGINE_PROBLEMS } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { rentFor, rentRate } from "../budget.js";
import { sol } from "./costs.js";
import { deviceOutput, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";
import { openingOutput, openingPayerOf, openingsFor, sendOpenings, skippedOf } from "./openings.js";
import { ATTEST_PAGES, DELIVERED_NEEDED, HISTORY_TOO_LONG, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, notEarliest, confirmedRelease } from "./delivery.js";
import { backedOrReceived, claimHeldBy, DEVICE_DIGEST, invitedPayees, receivedOutside, RELEASE_CHANGED } from "./attest.js";

export const VOTE_CHANGED = "this vote differs from its preview: the escrow, payee, result or delivered work changed, or no approval was given; preview it again and show the user";

export const COMMITTEE_CHANGED = "this committee differs from its preview: its members, threshold or fee wallet changed, or no approval was given; preview it again and show the user";

export const COMMITTEE_EXISTS = `this committee already exists; name it as attestor in ${tool("wallet_escrow")}`;

export const COMMITTEE_LIVE = `committee live; name it as attestor in ${tool("wallet_escrow")}, then each member votes with ${tool("wallet_committee_vote")}`;

export const NOT_A_MEMBER = "this server's wallet is not a member of the committee this escrow names, so it has no vote";

const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

const ballotInput = {
  owner: account("the wallet that made the escrow"),
  nonce: amount("the escrow intent's nonce"),
  pay_to: account("the wallet the release pays"),
  result: amount("the result the release attests, between the intent's min_result and max_result"),
  delivered_sha256: text("the sha256, as 64 hex digits, of the work the release pays for; its earliest announcer must be pay_to"),
  received_outside_announcement: receivedOutside,
  max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
};

type BallotArgs = { owner: Address; nonce: bigint; pay_to: Address; result: bigint; delivered_sha256: string; received_outside_announcement?: boolean | undefined; max_pages?: number | undefined };

async function ballotOf(ctx: AgentContext, input: BallotArgs, judge: Address, device: boolean, voting: boolean) {
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const target = { owner: input.owner, nonce: input.nonce, payTo: input.pay_to, result: input.result };
  let ballot: CommitteeBallot;
  try {
    ballot = await client.committeeBallot(target);
  } catch (error) {
    if (error instanceof ClaimHeldBy) {
      throw new AgentRefusal("ClaimHeld", claimHeldBy(error.worker, error.until));
    }
    if (error instanceof NotSettleable) {
      throw new AgentRefusal("KindMismatch", error.message);
    }
    throw error;
  }
  if (voting && !ballot.committee.members.includes(judge)) {
    throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
  }
  await invitedPayees(ctx, ballot.intent, [input.pay_to]);
  const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
  const keypair = await walletOpeners(ctx);
  const record = await deliveryRecord(ctx.transport, ballot.committee.address, ballot.intent, input.max_pages ?? ATTEST_PAGES, keypair);
  if (!record.complete) {
    throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
  }
  const first = firstDelivery(record.deliveries, delivered);
  const passed = await skippedOf(ctx, { judge, intent: ballot.intent, device, recipients: ballot.committee.members, record, first, openers: keypair });
  if (first !== null && first.worker !== input.pay_to) {
    throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
  }
  backedOrReceived(first, ballot.intent, delivered, input.received_outside_announcement);
  const confirmed = { intent: ballot.intent, attestor: ballot.committee.address, sha256: delivered, pages: input.max_pages ?? ATTEST_PAGES, payees: [input.pay_to], keypair };
  await confirmedRelease(ctx, confirmed);
  return { client, target, ballot, delivered, salt: first?.salt, openings: openingsFor(record, first), passed };
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
  description: `Votes, as a member of an escrow's judging committee, that it pays pay_to for the work with delivered_sha256. A team judges together: each member checks the work against the spec and votes; the signed vote is not sent but given to whoever releases with ${tool("wallet_committee_release")}. ${PREVIEW_APPROVAL}`,
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
    digest: text(DEVICE_DIGEST),
    summary: list(text(), 8),
    signed: flag(),
    vote: optional(object({ member: account(), signature: text("the member's ed25519 signature as 128 hex digits") })),
    next: optional(text()),
    skipped: openingOutput.skipped,
  }),
  run: async (ctx: AgentContext, input) => {
    const signer = await signerOf(ctx);
    const { ballot, delivered, salt, passed } = await ballotOf(ctx, input, signer.address, signer.device !== undefined, true);
    const approval = ballotApproval(ballot, delivered, salt);
    const shown = { intent: ballot.intent, committee: ballot.committee.address, approval, digest: hex(ballot.digest), summary: ballotLines(ballot, input, delivered), ...passed };
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
  description: `Pays a worker once a judging committee agrees: any one wallet collects the members' votes from ${tool("wallet_committee_vote")}, at least the committee's threshold, and submits them to release the escrow, recording the delivered work's sha256. Every vote is checked before sending. This wallet pays the fee. ${PREVIEW_APPROVAL}`,
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
    ...deviceOutput,
    ...openingOutput,
    summary: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, target, ballot, delivered, salt, openings, passed } = await ballotOf(ctx, input, signer.address, false, false);
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
    const device = signer.device !== undefined;
    const opener = device && openings.length > 0 ? await openingPayerOf(ctx) : signer;
    if (input.send === true && release.setup.length > 0 && !device) {
      await ctx.transport.send(release.setup, signer);
    }
    const instructions = device ? [...release.setup, ...release.instructions] : release.instructions;
    const prepared = input.send === true || device ? preparedView(await prepare(ctx.transport, instructions, signer.address)) : undefined;
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
    return "signature" in done ? { ...done, ...passed, ...(await sendOpenings(ctx, opener, ballot.committee.address, openings)) } : { ...done, ...passed };
  },
});

export const walletCommitteeCreate = define({
  name: tool("wallet_committee_create"),
  title: "Create a judging committee",
  description: `Creates a committee so a team judges together: its members and a threshold, how many of them must vote to release. Name the committee as attestor in ${tool("wallet_escrow")}; members vote with ${tool("wallet_committee_vote")}, then anyone releases with ${tool("wallet_committee_release")}. This wallet pays its rent. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    members: list(account(), MAX_COMMITTEE_MEMBERS, "the distinct member wallets, in any order", 1),
    threshold: integer(1, MAX_COMMITTEE_THRESHOLD, "how many members must vote to release, at most the member count"),
    fee_wallet: optional(account("the wallet the committee's judge fees go to; default this wallet")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true creates the committee; leave out to preview")),
  }),
  output: object({
    committee: account("the committee's address: name it as attestor in an escrow"),
    members: list(account(), MAX_COMMITTEE_MEMBERS),
    threshold: integer(1, MAX_COMMITTEE_THRESHOLD),
    fee_wallet: account(),
    exists: flag("true when this committee already exists, so nothing needs sending"),
    approval: optional(text()),
    summary: optional(list(text(), 6)),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const terms = { members: input.members, threshold: input.threshold, feeWallet: input.fee_wallet ?? signer.address };
    let built;
    try {
      built = await buildCreateCommittee({ ...terms, payer: signer });
    } catch (error) {
      throw error instanceof IntentCoreError ? new AgentRefusal("CommitteeInvalid", ENGINE_PROBLEMS.CommitteeInvalid.hint) : error;
    }
    const { committee, instruction } = built;
    const shown = { committee: committee.address, members: committee.members, threshold: committee.threshold, fee_wallet: committee.feeWallet };
    const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
    if ((await client.committee(committee.address)) !== null) {
      return { ...shown, exists: true, sent: false, next: COMMITTEE_EXISTS };
    }
    const rent = rentFor(getCommitteeSize(), await rentRate(ctx.transport));
    const summary = [
      `Creates: committee ${committee.address}; any ${committee.threshold} of its ${committee.members.length} members release an escrow that names it`,
      `Members: ${committee.members.join(", ")}`,
      `Pays judge fees to: ${committee.feeWallet}`,
      `Rent: ${sol(rent)} from this wallet ${signer.address}, kept by the committee account`,
    ];
    const approval = createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", COMMITTEE_CHANGED);
    }
    const view = {
      ...shown,
      exists: false,
      approval,
      summary,
      prepared: input.send === true || signer.device !== undefined ? preparedView(await prepare(ctx.transport, [instruction], signer.address)) : undefined,
    };
    return sent(ctx, signer, view, input.send, call, { preview: PREVIEW_APPROVAL_NEXT, done: COMMITTEE_LIVE });
  },
});
