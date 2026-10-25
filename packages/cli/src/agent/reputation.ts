import { createHash } from "node:crypto";
import { isSdkError, type Trust, trustOf } from "@intent-engine/client";
import { DELIVERY_PAGES, feedbackInstructions, reputationOf, RESTART, SIGNATURE_PAGE, TRUST_PATHS, TRUST_WALLETS } from "@intent-engine/client/internal";
import { type AgentContext, define } from "./actions.js";
import type { Call } from "./claims.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import { account, amount, choice, flag, hex32, integer, InvalidInput, list, nullable, object, optional, text, time } from "./schema.js";
import { preparedView } from "./shapes.js";
import { prepare } from "./prepare.js";
import { deviceOutput, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent } from "./wallet/guard.js";
import { refutationItem } from "./wallet/standing.js";

export const RECORDS_SHOWN = 50;

export const MAX_REPUTATION_PAGES = 100_000;

export const UNREADABLE_RECORDS = "refutations and announcements whose account has a layout this version cannot read; a release they touch is left out of the totals and complete is false";

export const REPUTATION_PAGES = `pages of ${SIGNATURE_PAGE} signatures of the worker's own history to read for its announcements; default ${DELIVERY_PAGES}; raise it when complete is false`;

const ROLES = ["announcer", "co-author"] as const;

export const FEEDBACK_CHANGED = "this feedback differs from its preview: the escrow, score or note changed, or no approval was given; preview it again and show the user";

const OUTCOMES = ["paid", "paid-other", "refunded", "open", "unknown"] as const;
const FUNDED = ["yes", "no", "unknown"] as const;

export function trustView(trust: Trust) {
  return {
    reader: trust.reader,
    seeds: trust.seeds,
    score: String(trust.score),
    complete: trust.complete,
    wallets: trust.wallets,
    paths: trust.paths.map((path) => ({ wallets: path.wallets, trust: String(path.trust) })),
    ...(trust.reason === undefined ? {} : { reason: trust.reason }),
  };
}

export const getReputation = define({
  name: tool("get_reputation"),
  title: "A worker's verifiable track record",
  description: `Read what a worker wallet has delivered and been paid for, from on-chain records only: every proof escrow it announced work to, and whether the escrow's release paid that wallet for that exact work. Releases where the worker paid or judged itself, or the payer judged its own escrow, are counted apart as self-dealt and left out of the totals. Releases whose payer was first funded by the worker, directly or through one wallet, are counted apart as funded by the worker and left out too; releases whose payer's funding could not be checked still count, are also shown as funding_unknown, and paid_verified counts only the checked ones. Releases a substantiated refutation shows someone announced the same work earlier are left out too. Each released escrow counts once, for the announcement it paid; a co-author counts only when a split release names it. backed sums the protocol fees behind the totals by the worker's share, per mint, and backed_sol the SOL ones plus every create fee. With reader, trust adds the worker's personalized PageRank rooted only in that reader and the seeds named, over the SOL its counted payments cost: a ring paying itself gets only trust that flows in from those roots, at most (1 - a) / a times the trust on the payments into it, with a = ${RESTART}. Use it before hiring a worker or trusting its delivery.`,
  effect: "read",
  input: object({
    worker: account("the worker wallet to read"),
    max_pages: optional(integer(1, MAX_REPUTATION_PAGES, REPUTATION_PAGES)),
    reader: optional(account("the wallet whose trust to start from")),
    seeds: optional(list(account(), TRUST_WALLETS, "more wallets that reader already relies on")),
  }),
  output: object({
    worker: account(),
    complete: flag("false means part of the history could not be read, so the totals may undercount"),
    reason: optional(text("why complete is false")),
    unreadable: optional(list(object({ account: account(), reason: text() }), RECORDS_SHOWN, UNREADABLE_RECORDS)),
    announced: integer(0, Number.MAX_SAFE_INTEGER, "escrows it announced work to"),
    paid: integer(0, Number.MAX_SAFE_INTEGER, "releases that paid it for its announced work, at arm's length"),
    paid_verified: integer(0, Number.MAX_SAFE_INTEGER, "of paid, the releases whose payer's funding was checked and not traced to it"),
    refuted: integer(0, Number.MAX_SAFE_INTEGER, "paid releases a substantiated refutation shows someone announced the same work earlier, left out of the totals"),
    self_dealt: integer(0, Number.MAX_SAFE_INTEGER, "paid releases where it paid or judged itself, left out of the totals"),
    funded_by_worker: integer(0, Number.MAX_SAFE_INTEGER, "other paid releases whose payer it funded first, left out of the totals"),
    funding_unknown: integer(0, Number.MAX_SAFE_INTEGER, "paid releases whose payer's funding could not be checked; they still count"),
    payers: integer(0, Number.MAX_SAFE_INTEGER, "distinct owners who paid it at arm's length"),
    judges: integer(0, Number.MAX_SAFE_INTEGER, "distinct judges or committees that released to it at arm's length"),
    committee_judged: integer(0, Number.MAX_SAFE_INTEGER, "arm's-length releases judged by a committee"),
    earned: list(object({ mint: account(), amount: amount("raw units") }), 32),
    backed: list(object({ mint: account(), amount: amount("raw units of protocol fees") }), 32),
    backed_sol: text("SOL protocol fees and every create fee behind the totals, in whole SOL"),
    feedback: object({ count: integer(0, Number.MAX_SAFE_INTEGER), average: nullable(text("average owner score out of 100")) }),
    first: nullable(time()),
    last: nullable(time()),
    records: list(
      object({
        intent: account(),
        announcement: account("the announcement the record is about; for a co-author, the one the split paid"),
        seq: amount(),
        role: choice(ROLES, "announcer: this wallet made the announcement; co-author: a split release paying it named this wallet"),
        sha256: optional(hex32()),
        outcome: choice(OUTCOMES),
        self_dealt: flag(),
        refuted_by: optional(text("a substantiated refutation: someone announced the same work earlier")),
        refutations: optional(list(refutationItem, 16, "refutations of the paid announcement, with their standing; only substantiated ones count")),
        funded_by_worker: optional(choice(FUNDED)),
        owner: optional(account()),
        attestor: optional(account()),
        earned: optional(amount()),
        feedback: optional(integer(0, 100)),
      }),
      RECORDS_SHOWN,
      `the ${RECORDS_SHOWN} most recent`,
    ),
    trust: optional(
      object({
        reader: account(),
        seeds: list(account(), TRUST_WALLETS + 1),
        score: text("trust from 0 to 1 that flows to the worker from the seeds"),
        complete: flag("false means a limit was reached or a read failed, so the score may undercount"),
        wallets: integer(0, Number.MAX_SAFE_INTEGER, "wallets read"),
        paths: list(object({ wallets: list(account(), TRUST_WALLETS + 1), trust: text() }), TRUST_PATHS, "seed to worker paths that carry the most trust"),
        reason: optional(text("why the score is 0")),
      }),
    ),
  }),
  run: async ({ transport }, input) => {
    if (input.reader === undefined && input.seeds !== undefined) {
      throw new InvalidInput([{ path: "seeds", message: "needs reader" }]);
    }
    const pages = input.max_pages === undefined ? {} : { pages: input.max_pages };
    const rep = await reputationOf(transport, input.worker, pages);
    const trust = input.reader === undefined ? undefined : await trustOf(transport, input.reader, input.worker, { ...pages, seeds: input.seeds ?? [] });
    return {
      worker: rep.wallet,
      complete: rep.complete,
      ...(rep.reason === undefined ? {} : { reason: rep.reason }),
      ...(rep.unreadable.length === 0 ? {} : { unreadable: rep.unreadable.slice(0, RECORDS_SHOWN).map(({ address, reason }) => ({ account: address, reason })) }),
      announced: rep.announced,
      paid: rep.paid,
      paid_verified: rep.paidVerified,
      refuted: rep.refuted,
      self_dealt: rep.selfDealt,
      funded_by_worker: rep.fundedByWorker,
      funding_unknown: rep.fundingUnknown,
      payers: rep.payers,
      judges: rep.judges,
      committee_judged: rep.committeeJudged,
      earned: rep.earned,
      backed: rep.backed,
      backed_sol: rep.backedSol,
      feedback: { count: rep.feedback.count, average: rep.feedback.average === null ? null : rep.feedback.average.toFixed(1) },
      first: rep.first,
      last: rep.last,
      records: rep.records.slice(-RECORDS_SHOWN).map((r) => ({
        intent: r.intent,
        announcement: r.announcement,
        seq: r.seq,
        role: r.role,
        ...(r.sha256 === "" ? {} : { sha256: r.sha256 }),
        outcome: r.outcome,
        self_dealt: r.selfDealt,
        ...(r.refutedBy === undefined ? {} : { refuted_by: r.refutedBy }),
        ...(r.refutations.length === 0
          ? {}
          : {
              refutations: r.refutations.slice(0, 16).map(({ refutation, earlier, earlierSeq, earlierWorker, standing }) => ({
                refutation,
                earlier,
                earlier_seq: earlierSeq,
                earlier_worker: earlierWorker,
                standing,
              })),
            }),
        ...(r.fundedByWorker === undefined ? {} : { funded_by_worker: r.fundedByWorker }),
        ...(r.owner === undefined ? {} : { owner: r.owner }),
        ...(r.attestor === undefined ? {} : { attestor: r.attestor }),
        ...(r.earned === undefined ? {} : { earned: r.earned }),
        ...(r.feedback === undefined ? {} : { feedback: r.feedback }),
      })),
      ...(trust === undefined ? {} : { trust: trustView(trust) }),
    };
  },
});

export const walletFeedback = define({
  name: tool("wallet_feedback"),
  title: "Rate work an escrow paid for",
  description: `Rates work the user paid for, from 0 to 100, as the owner of a released escrow, optionally with the sha256 of a written note. ${tool("get_reputation")} counts one rating per escrow, only from its owner. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  destructive: false,
  input: object({
    intent: account("the released escrow"),
    score: integer(0, 100, "0 is useless work, 100 is excellent"),
    note: optional(hex32("the sha256 of a note explaining the score")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true sends the feedback; leave out to preview")),
  }),
  output: object({
    intent: account(),
    score: integer(0, 100),
    approval: text(),
    summary: list(text(), 4),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const note = input.note?.toLowerCase();
    let instructions;
    try {
      instructions = await feedbackInstructions(ctx.transport, { owner: signer, intent: input.intent, score: input.score, ...(note === undefined ? {} : { note }) });
    } catch (error) {
      if (isSdkError(error, "not-settleable")) {
        throw new AgentRefusal("Unauthorized", error.message);
      }
      throw error;
    }
    const approval = createHash("sha256").update(`${input.intent}:${input.score}:${note ?? ""}`).digest("hex").slice(0, 16);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", FEEDBACK_CHANGED);
    }
    const view = {
      intent: input.intent,
      score: input.score,
      approval,
      summary: [
        `Rates: the work escrow ${input.intent} paid for, ${input.score} out of 100, signed by this wallet as its owner`,
        ...(note === undefined ? [] : [`Links: the note with sha256 ${note}`]),
      ],
      prepared: input.send === true || signer.device !== undefined ? preparedView(await prepare(ctx.transport, instructions, signer.address)) : undefined,
    };
    return sent(ctx, signer, view, input.send, call, {
      preview: PREVIEW_APPROVAL_NEXT,
      done: `recorded; ${tool("get_reputation")} counts it`,
    });
  },
});
