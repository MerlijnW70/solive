import { createHash } from "node:crypto";
import { AccountRole, type Address, getAddressDecoder, getBase16Decoder } from "@solana/kit";
import {
  attestedFillMessage,
  attestedProofMessage,
  buildEd25519Instruction,
  buildFillAttested,
  decodeParams,
  findIntentPda,
  formatAmount,
  formatTime,
  getIntentDecoder,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  releaseMemo,
  splitFees,
  settlementWarnings,
} from "@intent-engine/core";
import { chainTime, ClaimHeldBy, deliveryRecord, envelopeDigest, firstDelivery, loadConfig, MEMO_PROGRAM_ADDRESS, mintOf, releaseClaims, tokenAccountIfMissing } from "@intent-engine/client";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { WRAPPED } from "../create.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { sol, tokenAccountRent } from "./costs.js";
import { walletRecipient } from "../owner.js";
import { prepare } from "../prepare.js";
import { STATUS } from "../../accounts.js";
import { feePayerOf, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";
import { openingOutput, openingsFor, sendOpenings, skippedOf } from "./openings.js";
import { invitedTo, notInvited } from "../../invites.js";
import { notEarliest, DELIVERED_NEEDED, ATTEST_PAGES, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, HISTORY_TOO_LONG, notAttestor, confirmedRelease } from "./delivery.js";

export const RESULT_MEANS =
  "the plain count the attestor signs, between the escrow's min_result and max_result; it does not change the amount paid. On a proof escrow it records that the work passed the spec, and is 1 unless the escrow allows a range";

export const PAYEE_MOVED = "this wallet's token account for the escrowed token now belongs to someone else, so a release would not reach it; ask the payee for another wallet";

export const RELEASE_CHANGED = "this release differs from its preview: the payee, amount, result, fee or the escrow itself changed, or no approval was given; preview it again and show the user";

export const DEVICE_DIGEST = "the digest the Ledger shows when it signs the release message: compare the two before approving on the device";

export const DEVICE_RELEASE = "the Ledger shows digest when it signs the release message: show it to the user, who approves on the device only if its screen shows the same digest";

export const claimHeldBy = (worker: Address, until: bigint) =>
  `${worker} holds this job's claim until ${formatTime(until)}, so only that worker can be paid until then; nothing was sent`;

export async function claimsOfRelease(ctx: AgentContext, intent: Address, claims: number, payees: readonly Address[]) {
  try {
    return await releaseClaims(ctx.transport, intent, claims, payees);
  } catch (error) {
    if (error instanceof ClaimHeldBy) {
      throw new AgentRefusal("ClaimHeld", claimHeldBy(error.worker, error.until));
    }
    throw error;
  }
}

export const stakeReturned = (stake: bigint, stakeTo: Address | undefined): string[] =>
  stakeTo === undefined || stake === 0n ? [] : [`Returns: the claim stake of ${formatAmount(stake, 9)} SOL to ${stakeTo}`];

export const approvalOf = (message: Uint8Array, memo = ""): string => createHash("sha256").update(message).update(memo).digest("hex").slice(0, 16);

export const walletAttest = define({
  name: tool("wallet_attest"),
  title: "Release an escrow as its attestor",
  description: `Pays a worker for approved work: when this wallet is the attestor (judge) of an escrow made with ${tool("wallet_escrow")}, it releases the locked tokens, minus fees, to pay_to. A release cannot be undone. The approval holds the send to exactly what was previewed. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    pay_to: account("the wallet to pay"),
    result: optional(amount("the result to attest, a plain count not whole tokens, between the intent's min_result and max_result; default min_result")),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for: the same hash the worker announced with ${tool("wallet_deliver")}; required for a proof escrow, whose release pays that work's earliest announcer; recorded in a memo this wallet signs with the release, so the payer can check what it receives with ${tool("wallet_receipt")}; a Ledger wallet records none`)),
    max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    pay_to: account("the wallet this release pays, as given"),
    payee: account("pay_to's token account for the escrowed token, where the tokens land; it belongs to pay_to, and for SOL it holds wrapped SOL"),
    paid: text("whole tokens pay_to receives"),
    fee: text("whole tokens kept as fees"),
    result: amount(RESULT_MEANS),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    digest: optional(text(DEVICE_DIGEST)),
    delivered_sha256: optional(text("the sha256 the release records in a memo; absent on a Ledger wallet, whose release records none")),
    recorded: optional(flag("false when the release records no delivered work, as on a Ledger wallet")),
    ...openingOutput,
    summary: list(text(), 12),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const device = signer.device !== undefined;
    const payer = device ? await feePayerOf(ctx) : signer;
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
    const claimed = await claimsOfRelease(ctx, intent, held.claims, [input.pay_to]);
    const token = await mintOf(ctx.transport, held.inputMint);
    const payee = await tokenAccountIfMissing(ctx.transport, payer, input.pay_to, held.inputMint, token.tokenProgram);
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
    const maxFeeBps = held.feeBps + held.partnerBps;
    const shares = splitFees(settleAmount, held.feeBps, held.partnerBps, held.partnerCutBps);
    const treasury =
      shares.protocol > 0n
        ? await tokenAccountIfMissing(ctx.transport, payer, config.feeRecipient, held.inputMint, token.tokenProgram)
        : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner =
      partnerPaid ? await tokenAccountIfMissing(ctx.transport, payer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge =
      isProof && params.judgeFee > 0n
        ? await tokenAccountIfMissing(ctx.transport, payer, signer.address, held.inputMint, token.tokenProgram)
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
      solver: payer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      payee: payee.address,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(partnerPaid ? { partner: held.partner } : {}),
      ...(isProof && params.judgeFee > 0n ? { judge: signer.address } : {}),
      ...claimed.accounts,
      amountIn,
      result,
      maxFeeBps,
      capped: held.capped,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const paid = formatAmount(shares.net, token.decimals);
    const setup = [...payee.create, ...treasury.create, ...partner.create, ...judge.create];
    const delivered = input.delivered_sha256 === undefined ? undefined : sha256Of(input.delivered_sha256, "delivered_sha256");
    if (isProof && delivered === undefined) {
      throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
    }
    const keypair = await walletOpeners(ctx);
    let salt: string | undefined;
    let openings: ReturnType<typeof openingsFor> = [];
    let passed: { skipped?: string[] } = {};
    if (delivered !== undefined && isProof) {
      const record = await deliveryRecord(ctx.transport, signer.address, intent, input.max_pages ?? ATTEST_PAGES, keypair);
      if (!record.complete) {
        throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
      }
      const first = firstDelivery(record.deliveries, delivered);
      passed = await skippedOf(ctx, { judge: signer.address, intent, device, recipients: [signer.address], record, first, openers: keypair });
      if (first !== null && first.worker !== input.pay_to) {
        throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
      }
      salt = first?.salt;
      openings = openingsFor(record, first);
    }
    const confirmed = { intent, attestor: signer.address, sha256: isProof ? delivered : undefined, pages: input.max_pages ?? ATTEST_PAGES, payees: [input.pay_to], keypair };
    await confirmedRelease(ctx, confirmed);
    const memoText = delivered === undefined || device ? "" : releaseMemo(delivered, salt);
    const memo =
      memoText === ""
        ? []
        : [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(memoText) }];
    const approval = approvalOf(message, memoText);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const prepared =
      input.send === true
        ? preparedView(await prepare(ctx.transport, [...setup, buildEd25519Instruction({ publicKey: signer.address, signature: await signer.signBytes(message), message }), settle, ...memo], payer.address))
        : undefined;
    const paidBy = `${device ? "the fee payer" : "this wallet"}: ${setup.length === 0 ? "" : sol(await tokenAccountRent(ctx.transport, token.tokenProgram))} of rent`;
    const view2 = {
      intent,
      pay_to: input.pay_to,
      payee: payee.address,
      paid,
      fee: formatAmount(shares.protocol + shares.partner, token.decimals),
      result,
      approval,
      ...(device ? { digest: envelopeDigest(message) } : {}),
      ...(delivered === undefined ? {} : device ? { recorded: false } : { delivered_sha256: delivered }),
      summary: [
        `Pays: ${paid} of ${name} to ${input.pay_to} from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...(isProof && params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        ...(isProof ? [`Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`] : []),
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(delivered === undefined || device ? [] : [`Records: the delivered work's sha256 ${delivered}${salt === undefined ? "" : " and its announcer's salt"}, in a memo this wallet signs with the release`]),
        ...(device ? [`Signs: only the release message on the Ledger, which shows digest ${envelopeDigest(message)}; the fee payer ${payer.address} signs and pays the transaction, so no memo records the delivered work`] : []),
        ...stakeReturned(claimed.stake, claimed.accounts.stakeTo),
        ...(openings.length === 0 ? [] : [`Opens: the salts of ${openings.reduce((n, o) => n + o.salts.length, 0)} earlier announcement(s), in ${openings.length} more transaction(s) after the release`]),
        ...(payee.create.length === 0 ? [] : [`Setup: creates ${input.pay_to}'s ${name} account, paid by ${paidBy}`]),
        ...(treasury.create.length === 0 ? [] : [`Setup: creates the engine treasury's ${name} account for the fee, paid by ${paidBy}`]),
        ...(partner.create.length === 0 ? [] : [`Setup: creates the partner ${held.partner}'s ${name} account for its fee, paid by ${paidBy}`]),
        ...(judge.create.length === 0 ? [] : [`Setup: creates this wallet's ${name} account for the judge fee, paid by ${paidBy}`]),
      ],
      warnings: settlementWarnings(params),
      prepared,
    };
    const done = await sent(ctx, payer, view2, input.send, call, {
      preview: device ? `${PREVIEW_APPROVAL_NEXT}; ${DEVICE_RELEASE}` : PREVIEW_APPROVAL_NEXT,
      done: `released to ${input.pay_to}; ${tool("wallet_feedback")} to rate`,
    });
    return "signature" in done ? { ...done, ...passed, ...(await sendOpenings(ctx, payer, signer.address, openings)) } : { ...done, ...passed };
  },
});
