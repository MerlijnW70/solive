import { createHash } from "node:crypto";
import { feedbackInstructions, NotSettleable, reputationOf } from "@intent-engine/client";
import { type AgentContext, define } from "./actions.js";
import type { Call } from "./claims.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import { account, amount, choice, flag, hex32, integer, list, nullable, object, optional, text, time } from "./schema.js";
import { preparedView } from "./shapes.js";
import { prepare } from "./prepare.js";
import { signerOf, sent } from "./wallet/guard.js";
import { MAX_ATTEST_PAGES, MAX_PAGES_INPUT } from "./wallet/delivery.js";

export const RECORDS_SHOWN = 50;

export const FEEDBACK_CHANGED = "this feedback differs from its preview: the escrow, score or note changed, or no approval was given; preview it again and show the user";

const OUTCOMES = ["paid", "paid-other", "refunded", "open", "unknown"] as const;

export const getReputation = define({
  name: tool("get_reputation"),
  title: "A worker's verifiable track record",
  description: `Read what a worker wallet has delivered and been paid for, from on-chain records only: every proof escrow it announced work to, and whether the escrow's release paid that wallet for that exact work. Releases where the worker paid or judged itself, or the payer judged its own escrow, are counted apart as self-dealt and left out of the totals. Use it before hiring a worker or trusting its delivery. Payers rate released work with ${tool("wallet_feedback")}.`,
  effect: "read",
  input: object({
    worker: account("the worker wallet to read"),
    max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
  }),
  output: object({
    worker: account(),
    complete: flag("false means part of the history could not be read, so the totals may undercount"),
    announced: integer(0, Number.MAX_SAFE_INTEGER, "escrows it announced work to"),
    paid: integer(0, Number.MAX_SAFE_INTEGER, "releases that paid it for its announced work, at arm's length"),
    self_dealt: integer(0, Number.MAX_SAFE_INTEGER, "paid releases where it paid or judged itself, left out of the totals"),
    payers: integer(0, Number.MAX_SAFE_INTEGER, "distinct owners who paid it at arm's length"),
    judges: integer(0, Number.MAX_SAFE_INTEGER, "distinct judges or committees that released to it at arm's length"),
    committee_judged: integer(0, Number.MAX_SAFE_INTEGER, "arm's-length releases judged by a committee"),
    earned: list(object({ mint: account(), amount: amount("raw units") }), 32),
    feedback: object({ count: integer(0, Number.MAX_SAFE_INTEGER), average: nullable(text("average owner score out of 100")) }),
    first: nullable(time()),
    last: nullable(time()),
    records: list(
      object({
        intent: account(),
        sha256: hex32(),
        outcome: choice(OUTCOMES),
        self_dealt: flag(),
        owner: optional(account()),
        attestor: optional(account()),
        earned: optional(amount()),
        feedback: optional(integer(0, 100)),
      }),
      RECORDS_SHOWN,
      `the ${RECORDS_SHOWN} most recent`,
    ),
  }),
  run: async ({ transport }, input) => {
    const rep = await reputationOf(transport, input.worker, input.max_pages === undefined ? {} : { pages: input.max_pages });
    return {
      worker: rep.wallet,
      complete: rep.complete,
      announced: rep.announced,
      paid: rep.paid,
      self_dealt: rep.selfDealt,
      payers: rep.payers,
      judges: rep.judges,
      committee_judged: rep.committeeJudged,
      earned: rep.earned,
      feedback: { count: rep.feedback.count, average: rep.feedback.average === null ? null : rep.feedback.average.toFixed(1) },
      first: rep.first,
      last: rep.last,
      records: rep.records.slice(-RECORDS_SHOWN).map((r) => ({
        intent: r.intent,
        sha256: r.sha256,
        outcome: r.outcome,
        self_dealt: r.selfDealt,
        ...(r.owner === undefined ? {} : { owner: r.owner }),
        ...(r.attestor === undefined ? {} : { attestor: r.attestor }),
        ...(r.earned === undefined ? {} : { earned: r.earned }),
        ...(r.feedback === undefined ? {} : { feedback: r.feedback }),
      })),
    };
  },
});

export const walletFeedback = define({
  name: tool("wallet_feedback"),
  title: "Rate work an escrow paid for",
  description: `As the owner of a released proof escrow, rate the work it paid for from 0 to 100, optionally linking the sha256 of a written note. The rating is a memo this server's wallet signs, and ${tool("get_reputation")} counts it only from the escrow's owner, once per escrow. Without send it only previews; show the user the summary and, once they approve, call again with send: true and the approval the preview returned.`,
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
      if (error instanceof NotSettleable) {
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
      prepared: input.send === true ? preparedView(await prepare(ctx.transport, instructions, signer.address)) : undefined,
    };
    return sent(ctx, signer, view, input.send, call);
  },
});
