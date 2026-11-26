import { createHash } from "node:crypto";
import { getBase16Decoder } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { decodeParams, findIntentPda } from "@intent-engine/core/internal";
import { intentAt } from "@intent-engine/client/internal";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, choice, flag, list, object, optional, text } from "../schema.js";
import { PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, sha256Of, signerOf } from "./guard.js";
import {
  parsedReview,
  REASON_RULE,
  reasonFits,
  REVIEW_VERDICTS,
  reviewJson,
  type ReviewSignature,
  reviewSha256,
  ReviewUnreadable,
  signatureHolds,
  signedReview,
  type Statement,
  statementOf,
} from "../../review.js";

export const REVIEW_CHANGED = "this review differs from its preview, or no approval was given; preview it again and show the user";

export const REVIEW_ON_DEVICE = "a review is signed with a key file wallet; this wallet signs on a Ledger, so nothing was signed";

export const REVIEW_DONE = "save review as a file and hand it to the judge, who passes it to the CLI command judge with --review; another reviewer co-signs it by passing it back as review";

export const REVIEW_OTHER = "review signs another statement than owner, nonce, delivered_sha256, outcome and reason give; pass the same values to co-sign it";

const approvalOf = (sha256: string): string => createHash("sha256").update(sha256).digest("hex").slice(0, 16);

async function priorOf(given: string | undefined, statement: Statement): Promise<ReviewSignature[]> {
  if (given === undefined) {
    return [];
  }
  let held;
  try {
    held = parsedReview(given, "review");
  } catch (error) {
    throw error instanceof ReviewUnreadable ? new AgentRefusal("ReviewRefused", `review ${error.why}; nothing was signed`) : error;
  }
  const other = statementOf(held);
  if (reviewSha256(other) !== reviewSha256(statement)) {
    throw new AgentRefusal("ReviewRefused", REVIEW_OTHER);
  }
  for (const signed of held.signatures) {
    if (!(await signatureHolds(other, signed))) {
      throw new AgentRefusal("ReviewRefused", `review carries a signature of ${signed.reviewer} that does not sign its statement; nothing was signed`);
    }
  }
  return held.signatures;
}

export const walletReview = define({
  name: tool("wallet_review"),
  title: "Sign a review of delivered work",
  description: `Signs, as a reviewer a spec's judge-review block names, a review binding the escrow, spec and work to pay or fail and a reason. The judge passes it to CLI judge --review. Pass an earlier review as review to co-sign. Sends nothing. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    delivered_sha256: text(`the sha256, as 64 hex digits, of the work reviewed, as ${tool("wallet_fetch_work")} shows it`),
    outcome: choice(REVIEW_VERDICTS, "pay when the work meets the spec, fail when it does not"),
    reason: text(`why, in ${REASON_RULE}; it is part of what is signed`),
    review: optional(text("an earlier review file's JSON of the same statement, to add this wallet's signature to it")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the review; leave out to preview")),
  }),
  output: object({
    intent: account(),
    spec_sha256: text("the escrow's spec sha256 the review binds"),
    delivered_sha256: text(),
    statement_sha256: text("the sha256 of the signed statement, which the judge's receipt records"),
    signers: list(account(), 64, "the reviewers whose signatures the review carries"),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    signed: flag(),
    review: optional(text("the review file's JSON; save it as a file for the judge")),
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const signer = await signerOf(ctx);
    if (signer.device !== undefined) {
      throw new AgentRefusal("ReviewRefused", REVIEW_ON_DEVICE);
    }
    if (!reasonFits(input.reason)) {
      throw new AgentRefusal("ReviewRefused", `reason must be ${REASON_RULE}; nothing was signed`);
    }
    const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
    const held = await intentAt(ctx.transport, intent);
    const params = held === null ? undefined : decodeParams(held.kind, Uint8Array.from(held.params));
    if (params === undefined || params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
      throw new AgentRefusal("ReviewRefused", `intent ${intent} is not a proof escrow, so there is no work to review; nothing was signed`);
    }
    const statement: Statement = {
      cluster: await ctx.transport.genesisHash(),
      intent,
      nonce: input.nonce,
      specSha256: getBase16Decoder().decode(params.specHash).toLowerCase(),
      deliveredSha256: sha256Of(input.delivered_sha256, "delivered_sha256"),
      verdict: input.outcome,
      reason: input.reason,
    };
    const prior = await priorOf(input.review, statement);
    const sha256 = reviewSha256(statement);
    const approval = approvalOf(sha256);
    const shown = { intent, spec_sha256: statement.specSha256, delivered_sha256: statement.deliveredSha256, statement_sha256: sha256, approval };
    if (input.send !== true) {
      return { ...shown, signers: prior.map(({ reviewer }) => reviewer), signed: false, next: PREVIEW_APPROVAL_NEXT };
    }
    if (input.approval !== approval) {
      throw new AgentRefusal("ReviewRefused", REVIEW_CHANGED);
    }
    const review = await signedReview(signer, statement, prior);
    return { ...shown, signers: review.signatures.map(({ reviewer }) => reviewer), signed: true, review: reviewJson(review), next: REVIEW_DONE };
  },
});
