import { createHash } from "node:crypto";
import { AccountRole, getAddressDecoder, getBase16Decoder } from "@solana/kit";
import {
  attestedFillMessage,
  attestedProofMessage,
  buildEd25519Instruction,
  buildFillAttested,
  decodeParams,
  feeBpsFor,
  findIntentPda,
  formatAmount,
  getIntentDecoder,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  releaseMemo,
  splitFees,
  settlementWarnings,
} from "@intent-engine/core";
import { chainTime, deliveryRecord, firstDelivery, loadConfig, MEMO_PROGRAM_ADDRESS, mintOf, tokenAccountIfMissing } from "@intent-engine/client";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { WRAPPED } from "../create.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { walletRecipient } from "../owner.js";
import { prepare } from "../prepare.js";
import { STATUS } from "../../accounts.js";
import { signerOf, sent, sha256Of } from "./guard.js";
import { invitedTo, notInvited } from "../../invites.js";
import { notEarliest, DELIVERED_NEEDED, ATTEST_PAGES, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, HISTORY_TOO_LONG, notAttestor } from "./delivery.js";

export const PAYEE_MOVED = "this wallet's token account for the escrowed token now belongs to someone else, so a release would not reach it; ask the payee for another wallet";

export const RELEASE_CHANGED = "this release differs from its preview: the payee, amount, result, fee or the escrow itself changed, or no approval was given; preview it again and show the user";

export const approvalOf = (message: Uint8Array, memo = ""): string => createHash("sha256").update(message).update(memo).digest("hex").slice(0, 16);

export const walletAttest = define({
  name: tool("wallet_attest"),
  title: "Release an escrow as its attestor",
  description: `As the attestor an escrow names, sign that it pays pay_to and settle it on chain from this server's wallet: the escrowed tokens, minus the engine fee and any partner fee, go to pay_to's token account, which this creates if needed. Use it when this server's wallet was named attestor of an intent made with ${tool("wallet_escrow")} and the work it pays for is done. A release cannot be undone. Without send it only previews and signs nothing; show the user the summary and, once they approve, call again with send: true and the approval the preview returned, which holds the send to exactly what was previewed.`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    pay_to: account("the wallet to pay"),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for; required for a proof escrow, whose release pays that work's earliest announcer; recorded in a memo this wallet signs with the release, so the payer can check what it receives with ${tool("wallet_receipt")}`)),
    max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    pay_to: account(),
    payee: account("pay_to's token account that receives the escrow"),
    paid: text("whole tokens pay_to receives"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: optional(text("the sha256 the release records")),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
    const [view, { config }] = await Promise.all([ctx.transport.getAccount(intent), loadConfig(ctx.transport)]);
    if (view === null) {
      throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled, cancelled and closed, or never made`);
    }
    const held = getIntentDecoder().decode(view.data);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind !== Kind.AttestedResult) {
      throw new AgentRefusal("KindMismatch", "this intent is not an attested escrow");
    }
    if (params.attestor !== signer.address) {
      throw new AgentRefusal("Unauthorized", notAttestor(params.attestor));
    }
    if (held.status !== IntentStatus.Open) {
      throw new AgentRefusal("InvalidTransition", `this escrow is ${STATUS[held.status] ?? "not open"}, so it can no longer be released`);
    }
    if (held.expiresAt <= (await chainTime(ctx.transport))) {
      throw new AgentRefusal("IntentExpired", "this escrow has expired; its owner gets it back instead");
    }
    const result = input.result ?? params.minResult;
    if (result < params.minResult || result > params.maxResult) {
      throw new InvalidInput([{ path: "result", message: `must be between ${params.minResult} and ${params.maxResult}` }]);
    }
    await walletRecipient(ctx.transport, input.pay_to, "pay_to");
    const invited = await invitedTo(ctx.transport, ctx.fetch, intent);
    if (invited !== undefined && !invited.includes(input.pay_to)) {
      throw new AgentRefusal("NotInvited", notInvited(input.pay_to, intent));
    }
    const token = await mintOf(ctx.transport, held.inputMint);
    const payee = await tokenAccountIfMissing(ctx.transport, signer, input.pay_to, held.inputMint, token.tokenProgram);
    if (payee.create.length === 0) {
      const existing = await ctx.transport.getAccount(payee.address);
      const holder = existing === null || existing.data.length < 64 ? null : getAddressDecoder().decode(existing.data.subarray(32, 64));
      if (holder !== input.pay_to) {
        throw new InvalidInput([{ path: "pay_to", message: PAYEE_MOVED }]);
      }
    }
    const amountIn = held.escrowed - held.filled;
    const isProof = params.specHash.some((b) => b !== 0);
    const settleAmount = amountIn - params.judgeFee;
    const maxFeeBps = feeBpsFor(config, held.kind) + held.partnerBps;
    const shares = splitFees(settleAmount, feeBpsFor(config, held.kind), held.partnerBps, held.partnerCutBps);
    const treasury =
      shares.protocol > 0n
        ? await tokenAccountIfMissing(ctx.transport, signer, config.feeRecipient, held.inputMint, token.tokenProgram)
        : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner =
      partnerPaid ? await tokenAccountIfMissing(ctx.transport, signer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge =
      isProof && params.judgeFee > 0n
        ? await tokenAccountIfMissing(ctx.transport, signer, signer.address, held.inputMint, token.tokenProgram)
        : { create: [] };
    const attestFields = {
      domain: Uint8Array.from(config.domain),
      intent,
      payee: payee.address,
      amountIn,
      result,
      filled: held.filled,
      revision: held.revision,
      maxFeeBps,
    };
    const message = isProof
      ? await attestedProofMessage(signer.address, { ...attestFields, specHash: params.specHash })
      : await attestedFillMessage(signer.address, attestFields);
    const settle = await buildFillAttested({
      solver: signer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      payee: payee.address,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(partnerPaid ? { partner: held.partner } : {}),
      ...(isProof && params.judgeFee > 0n ? { judge: signer.address } : {}),
      amountIn,
      result,
      maxFeeBps,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const paid = formatAmount(shares.net, token.decimals);
    const setup = [...payee.create, ...treasury.create, ...partner.create, ...judge.create];
    const delivered = input.delivered_sha256 === undefined ? undefined : sha256Of(input.delivered_sha256, "delivered_sha256");
    if (isProof && delivered === undefined) {
      throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
    }
    if (delivered !== undefined && isProof) {
      const record = await deliveryRecord(ctx.transport, signer.address, intent, input.max_pages ?? ATTEST_PAGES);
      if (!record.complete) {
        throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
      }
      const first = firstDelivery(record.deliveries, delivered);
      if (first !== null && first.worker !== input.pay_to) {
        throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
      }
    }
    const memoText = delivered === undefined ? "" : releaseMemo(delivered);
    const memo =
      delivered === undefined
        ? []
        : [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(memoText) }];
    const approval = approvalOf(message, memoText);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const prepared =
      input.send === true
        ? preparedView(await prepare(ctx.transport, [...setup, buildEd25519Instruction({ publicKey: signer.address, signature: await signer.signBytes(message), message }), settle, ...memo], signer.address))
        : undefined;
    const view2 = {
      intent,
      pay_to: input.pay_to,
      payee: payee.address,
      paid,
      fee: formatAmount(shares.protocol + shares.partner, token.decimals),
      result,
      approval,
      ...(delivered === undefined ? {} : { delivered_sha256: delivered }),
      summary: [
        `Pays: ${paid} of ${name} to ${input.pay_to} from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...(isProof && params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        ...(isProof ? [`Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`] : []),
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(delivered === undefined ? [] : [`Records: the delivered work's sha256 ${delivered}, in a memo this wallet signs with the release`]),
        ...(payee.create.length === 0 ? [] : [`Setup: creates ${input.pay_to}'s ${name} account, paid by this wallet`]),
        ...(treasury.create.length === 0 ? [] : [`Setup: creates the engine treasury's ${name} account for the fee, paid by this wallet`]),
        ...(partner.create.length === 0 ? [] : [`Setup: creates the partner ${held.partner}'s ${name} account for its fee, paid by this wallet`]),
      ],
      warnings: settlementWarnings(params),
      prepared,
    };
    return sent(ctx, signer, view2, input.send, call);
  },
});
