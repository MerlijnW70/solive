import { createHash } from "node:crypto";
import { type Address, getBase16Decoder, type Instruction } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { buildCreateCommittee, committeeEnvelope, decodeParams, findIntentPda, getCommitteeSize, MAX_COMMITTEE_MEMBERS, MAX_COMMITTEE_THRESHOLD } from "@intent-engine/core/internal";
import { type CommitteeBallot, isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { intentAt } from "@intent-engine/client/internal";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal, ENGINE_PROBLEMS } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { rentFor, rentRate } from "../budget.js";
import { TOKEN_NAMES } from "../../tokens.js";
import { sol, tokenAccountRent } from "./costs.js";
import { deviceOutput, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";
import { firstOpeningFor, skippedField, skippedOutput } from "./openings.js";
import { confirmedRelease } from "./delivery.js";
import { DEVICE_DIGEST, invitedPayees, RELEASE_CHANGED, settleRefused } from "./attest.js";

export const VOTE_CHANGED = "this vote differs from its preview: the escrow, payee, result or delivered work changed, or no approval was given; preview it again and show the user";

export const COMMITTEE_CHANGED = "this committee differs from its preview: its members, threshold or fee wallet changed, or no approval was given; preview it again and show the user";

export const COMMITTEE_EXISTS = `this committee already exists; name it as attestor in ${tool("wallet_escrow")}`;

export const COMMITTEE_LIVE = `committee live; name it as attestor in ${tool("wallet_escrow")}, then each member votes with ${tool("wallet_committee_vote")}`;

export const NOT_A_MEMBER = "this server's wallet is not a member of the committee this escrow names, so it has no vote";

const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

const ballotInput = {
  owner: account("the wallet that made the escrow"),
  nonce: amount("the escrow intent's nonce"),
  result: amount("the result the release attests, between the intent's min_result and max_result"),
  delivered_sha256: text(`the sha256, as 64 hex digits, of the work the release pays for, as ${tool("wallet_fetch_work")} shows it; the release pays the first announcement that opens to it`),
};

type BallotArgs = { owner: Address; nonce: bigint; result: bigint; delivered_sha256: string };

async function ballotOf(ctx: AgentContext, input: BallotArgs, judge: Address, device: boolean, voting: boolean) {
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
  const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
  if (voting) {
    const held = await intentAt(ctx.transport, intent);
    const params = held === null ? null : decodeParams(held.kind, Uint8Array.from(held.params));
    const judging = params === null || params.kind !== Kind.AttestedResult ? null : await client.committee(params.attestor);
    if (judging !== null && !judging.members.includes(judge)) {
      throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
    }
  }
  const { opening, skipped } = await firstOpeningFor(ctx, judge, intent, delivered, device);
  const target = { intent: { owner: input.owner, nonce: input.nonce }, announcement: opening.announcement, opening: { sha256: delivered, salt: opening.salt }, result: input.result };
  const ballot: CommitteeBallot = await client.committeeBallot(target).catch(settleRefused);
  if (voting && !ballot.committee.members.includes(judge)) {
    throw new AgentRefusal("Unauthorized", NOT_A_MEMBER);
  }
  await invitedPayees(ctx, ballot.intent, [opening.worker]);
  await confirmedRelease(ctx, { intent: ballot.intent, attestor: ballot.committee.address, sha256: delivered, payees: [opening.worker], keypair: await walletOpeners(ctx) });
  return { client, target, ballot, delivered, opening, skipped };
}

const ballotApproval = (ballot: CommitteeBallot) => createHash("sha256").update(ballot.digest).digest("hex").slice(0, 16);

const releaseApproval = (ballot: CommitteeBallot, setup: readonly string[]) =>
  createHash("sha256").update(ballot.digest).update(JSON.stringify(setup)).digest("hex").slice(0, 16);

async function setupLines(ctx: AgentContext, setup: readonly Instruction[], payer: Address, device: boolean): Promise<string[]> {
  const where = device ? "in the release transaction" : "in its own transaction before the release";
  return Promise.all(
    setup.map(async ({ accounts }) => {
      const [, created, owner, mint, , tokenProgram] = (accounts ?? []).map((one) => one.address);
      if (created === undefined || owner === undefined || mint === undefined || tokenProgram === undefined) {
        throw new Error("a release setup instruction names no token account");
      }
      const rent = await tokenAccountRent(ctx.transport, tokenProgram);
      return `Setup: creates ${owner}'s ${TOKEN_NAMES[mint] ?? mint} account ${created}, ${where}; ${sol(rent)} of rent from this wallet ${payer}`;
    }),
  );
}

const ballotLines = (ballot: CommitteeBallot, input: BallotArgs, delivered: string, worker: Address, announcement: Address) => [
  `Releases: escrow ${ballot.intent} to ${worker}, who made the announcement ${announcement}, with result ${input.result}`,
  `Pays for: the work with sha256 ${delivered}`,
  `Judged by: committee ${ballot.committee.address}, any ${ballot.committee.threshold} of its ${ballot.committee.members.length} members`,
];

const announced = {
  announcement: account("the announcement the release pays"),
  worker: account("the wallet the release pays"),
  seq: amount(),
};

export const walletCommitteeVote = define({
  name: tool("wallet_committee_vote"),
  title: "Vote on a release as a committee member",
  description: `Votes, as a member of an escrow's judging committee, that it pays the first announcement that opens to delivered_sha256. A team judges together: each member checks the work against the spec and votes; the signed vote is not sent but given to whoever releases with ${tool("wallet_committee_release")}. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    ...ballotInput,
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the vote; leave out to preview")),
  }),
  output: object({
    intent: account(),
    committee: account(),
    ...announced,
    approval: text(),
    digest: text(DEVICE_DIGEST),
    summary: list(text(), 8),
    signed: flag(),
    vote: optional(object({ member: account(), signature: text("the member's ed25519 signature as 128 hex digits") })),
    next: optional(text()),
    skipped: skippedOutput,
  }),
  run: async (ctx: AgentContext, input) => {
    const signer = await signerOf(ctx);
    const { ballot, delivered, opening, skipped } = await ballotOf(ctx, input, signer.address, signer.device !== undefined, true);
    const approval = ballotApproval(ballot);
    const shown = {
      intent: ballot.intent,
      committee: ballot.committee.address,
      announcement: opening.announcement,
      worker: opening.worker,
      seq: opening.seq,
      approval,
      digest: hex(ballot.digest),
      summary: ballotLines(ballot, input, delivered, opening.worker, opening.announcement),
      ...skippedField(skipped),
    };
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
  description: `Pays a worker once a judging committee agrees: any one wallet collects the members' votes from ${tool("wallet_committee_vote")}, at least the committee's threshold, and submits them to pay the announcement they voted on. Every vote is checked before sending. This wallet pays the fee and rent. ${PREVIEW_APPROVAL}`,
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
    ...announced,
    signers: list(account(), 8),
    approval: text(),
    ...deviceOutput,
    skipped: skippedOutput,
    summary: list(text(), 12),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, target, ballot, delivered, opening, skipped } = await ballotOf(ctx, input, signer.address, false, false);
    const votes = input.votes.map((vote, i) => {
      if (!/^[0-9a-fA-F]{128}$/.test(vote.signature)) {
        throw new InvalidInput([{ path: `votes.${i}.signature`, message: "give the signature as 128 hex digits" }]);
      }
      return { member: vote.member, signature: Uint8Array.from(Buffer.from(vote.signature, "hex")) };
    });
    let release;
    try {
      release = await client.plan.settleCommittee({ ...target, solver: signer, votes });
    } catch (error) {
      if (isSdkError(error, "vote-rejected")) {
        throw new AgentRefusal("SigMessage", error.message);
      }
      return settleRefused(error);
    }
    const device = signer.device !== undefined;
    const setup = await setupLines(ctx, release.setup, signer.address, device);
    const approval = releaseApproval(ballot, setup);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    if (input.send === true && release.setup.length > 0 && !device) {
      await ctx.transport.send(release.setup, signer);
    }
    const instructions = device ? [...release.setup, ...release.instructions] : release.instructions;
    const prepared = input.send === true || device ? preparedView(await prepare(ctx.transport, instructions, signer.address)) : undefined;
    const view = {
      intent: release.intent,
      committee: release.committee.address,
      announcement: opening.announcement,
      worker: opening.worker,
      seq: opening.seq,
      signers: release.voters,
      approval,
      ...skippedField(skipped),
      summary: [
        ...ballotLines(ballot, input, delivered, opening.worker, opening.announcement),
        `Signed by: ${release.voters.length} of its members, ${release.voters.join(", ")}`,
        `Pays the fee: this server's wallet ${signer.address}`,
        ...setup,
      ],
      prepared,
    };
    return sent(ctx, signer, view, input.send, call, {
      preview: PREVIEW_APPROVAL_NEXT,
      done: `release sent; ${tool("wallet_feedback")} to rate if you own it`,
    });
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
      throw isSdkError(error, "intent-core-error") ? new AgentRefusal("CommitteeInvalid", ENGINE_PROBLEMS.CommitteeInvalid.hint) : error;
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
