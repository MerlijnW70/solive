import { committeeEnvelope, findIntentPda } from "@intent-engine/core/internal";
import { isSdkError } from "@intent-engine/client";
import { rejectLines } from "../../fair-lines.js";
import { createClient } from "@intent-engine/client/node";
import { envelopeDigest } from "@intent-engine/client/internal";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, flag, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { ReceiptRefused } from "../../judge-receipt.js";
import { authorizeEscrow, boundApproval, OVERRIDE_INPUT, recorded } from "../../receipt-gate.js";
import { approvalOf, capturedSettle, DEVICE_DIGEST, RELEASE_CHANGED, uncheckedOutput } from "./attest.js";
import { workRefusal } from "../../reject-check.js";
import { feePayerOf, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, sent, sha256Of, signerOf, walletOpeners } from "./guard.js";

export const WALLET_REJECT_RECEIPT_NEXT = `run ${tool("wallet_judge_work")} or the CLI command judge on this work first, which saves a receipt when the check fails, or pass ${OVERRIDE_INPUT} with a reason to reject without one; nothing was signed or sent`;

export const VOTE_NEXT = `this member's reject vote; give it to whoever relays the reject, who passes the votes of the committee's threshold to ${tool("wallet_reject")} as votes`;

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export function rejectRefused(error: unknown): never {
  if (isSdkError(error, "not-settleable") || isSdkError(error, "vote-rejected")) {
    throw new AgentRefusal("NotRejectable", error.message);
  }
  throw error;
}

const voteShape = object({ member: account(), signature: text("128 hex digits: the member's signature over the reject ballot") });

export const walletReject = define({
  name: tool("wallet_reject"),
  title: "Reject a delivery as its judge",
  description: `Rejects announced work that failed the spec, as its judge: it is never paid, and a holder under review gets its stake back. A committee member signs a reject vote; votes of the threshold let anyone relay it. Needs a failing run's receipt or without_receipt. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    announcement: account(`the announcement to reject, as ${tool("wallet_check_delivery")} lists it`),
    delivered_sha256: text("the sha256, as 64 hex digits, of the work the judge run failed"),
    votes: optional(list(voteShape, 8, "committee reject votes, one per member, to relay the reject")),
    without_receipt: optional(text("a non-empty reason to reject without a receipt of a failing judge run on this machine; the output records it in unchecked")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs and sends the reject, or signs this member's vote; leave out to preview")),
  }),
  output: object({
    intent: account(),
    announcement: account(),
    worker: account("the wallet that announced the work"),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    digest: text(DEVICE_DIGEST),
    review_until: optional(amount("unix seconds the review of this announcement runs until; a reject must land before it")),
    vote: optional(voteShape),
    unchecked: uncheckedOutput,
    summary: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const payer = signer.device === undefined ? signer : await feePayerOf(ctx);
    const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
    const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
    const target = { intent, announcement: input.announcement };
    const ballot = await client.rejectBallot(target).catch(rejectRefused);
    const sha256 = sha256Of(input.delivered_sha256, "delivered_sha256");
    const relay = input.votes !== undefined && input.votes.length > 0;
    const judges = ballot.committee?.members ?? [ballot.attestor];
    if (!relay && !judges.includes(signer.address)) {
      throw new AgentRefusal("NotRejectable", `${signer.address} is not the judge of escrow ${intent}${ballot.committee === null ? "" : " nor a member of its committee"}; nothing was signed or sent`);
    }
    const unchecked = relay ? undefined : await workRefusal(ctx.transport, input.announcement, sha256, await walletOpeners(ctx));
    if (unchecked !== undefined) {
      throw new AgentRefusal("NotRejectable", unchecked);
    }
    const authority = relay
      ? undefined
      : await authorizeEscrow(ctx.wallet?.files.home, ctx.transport, { owner: input.owner, nonce: input.nonce, intent, deliveredSha256: sha256, announcement: input.announcement }, [signer.address], input.without_receipt, "fail").catch((error: unknown) => {
          throw error instanceof ReceiptRefused ? new AgentRefusal("NoJudgeReceipt", `${error.why}; ${WALLET_REJECT_RECEIPT_NEXT}`) : error;
        });
    const digest = ballot.committee === null ? envelopeDigest(ballot.message) : hexOf(ballot.digest);
    const approval = boundApproval(approvalOf(ballot.committee === null ? ballot.message : ballot.digest), authority);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const view = {
      intent,
      announcement: input.announcement,
      worker: ballot.worker,
      approval,
      digest,
      ...(ballot.review === null ? {} : { review_until: ballot.review.until }),
      ...recorded(authority),
      summary: rejectLines(ballot, sha256),
    };
    if (ballot.committee !== null && !relay) {
      if (input.send !== true) {
        return { ...view, sent: false, next: PREVIEW_APPROVAL_NEXT };
      }
      const signature = await signer.signBytes(committeeEnvelope(ballot.digest, ballot.committee.members));
      return { ...view, vote: { member: signer.address, signature: hexOf(signature) }, sent: false, next: VOTE_NEXT };
    }
    const votes = (input.votes ?? []).map(({ member, signature }) => ({ member, signature: Uint8Array.from(Buffer.from(signature, "hex")) }));
    const build = () =>
      capturedSettle(ctx, (relayed) =>
        relay ? relayed.rejectCommittee({ ...target, relayer: payer, votes }).catch(rejectRefused) : relayed.reject({ ...target, judge: signer, payer }).catch(rejectRefused),
      );
    const prepared = input.send === true ? preparedView(await prepare(ctx.transport, await build(), payer.address)) : undefined;
    return sent(ctx, payer, { ...view, prepared }, input.send, call, { preview: PREVIEW_APPROVAL_NEXT, done: `rejected; the worker sees it in ${tool("wallet_history")}` });
  },
});
