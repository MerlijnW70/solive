import { createHash } from "node:crypto";
import { AccountRole, type Address, getBase16Decoder, getBase16Encoder } from "@solana/kit";
import {
  attestedSplitMessage,
  attestedSplitPreimage,
  buildEd25519BatchInstruction,
  buildFillAttestedSplit,
  decodeParams,
  findIntentPda,
  formatAmount,
  getIntentDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
  MAX_SPLIT_RECIPIENTS,
  NATIVE_MINT,
  releaseMemo,
  splitCommit,
  splitFees,
  splitPayout,
  settlementWarnings,
} from "@intent-engine/core";
import { decodeLookupTable } from "@intent-engine/solver";
import {
  chainTime,
  deliveryRecord,
  firstDelivery,
  followUpInstructions,
  followUpMemo,
  followUpOf,
  loadConfig,
  MEMO_PROGRAM_ADDRESS,
  mintOf,
  neverLanded,
  PACKET_DATA_SIZE,
  tokenAccountIfMissing,
} from "@intent-engine/client";
import { execute } from "../../flows.js";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { WRAPPED } from "../create.js";
import { tool } from "../names.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { InvalidInput, account, amount, choice, flag, integer, list, object, optional, type Schema, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { walletRecipient } from "../owner.js";
import { prepare, transactionSize } from "../prepare.js";
import { STATUS } from "../../accounts.js";
import { PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, WAIT_SCAN, signerOf, sent, sha256Of } from "./guard.js";
import { RELEASE_CHANGED, approvalOf } from "./attest.js";
import { notInSplit, DELIVERED_NEEDED, ATTEST_PAGES, MAX_ATTEST_PAGES, MAX_PAGES_INPUT, HISTORY_TOO_LONG, notAttestor, confirmedRelease } from "./delivery.js";

export const SPLIT_FITS = 2;
export const SPLIT_FITS_WITH_TABLE = 4;
export const splitTooLarge = (size: number, recipients: number, withTable: boolean): string =>
  `this ${recipients}-co-author split builds a ${size}-byte transaction without the delivery memo, over the ${PACKET_DATA_SIZE}-byte limit${withTable ? " even with the lookup table" : ""}; a release fits ${SPLIT_FITS} co-authors without a lookup table and ${SPLIT_FITS_WITH_TABLE} with one when their token accounts exist, and fewer when this wallet creates them in the same transaction${withTable ? ", so reduce recipients or pay the rest in a second release" : ", so pass lookup_table with the preview's lookup_accounts to fit more, or reduce recipients"}`;
export const RECORDS_SPLIT = (delivered: string): string =>
  `Records: the delivered work's sha256 ${delivered}, in a memo this wallet signs with the release, or in a follow-up transaction this wallet signs right after it when the release has no room for the memo`;
export const followUpFailed = (reason: string): string =>
  `the release landed, but the follow-up transaction that records the delivered work's sha256 failed, so the hash is not recorded on chain: ${reason}; to record it, call ${tool("wallet_record_delivery")} with the same owner and nonce, the delivered_sha256 as sha256 and this signature as release, which sends the memo in record_memo for ${tool("wallet_receipt")} to read`;
export const SPLIT_WEIGHTS_WRONG = "the weights must be whole basis points that add up to 10000";
export const SPLIT_SIG_NEEDED = "every co-author must sign the split before send: true; preview returns the envelope each one signs";
export const SIGNATURE_PATTERN = "^[0-9a-fA-F]{128}$";
export const WARN_COAUTHORS = "every co-author must sign the exact split; a release pays only the recipients and weights they all signed";

const coauthor = object({
  wallet: account("the co-author's wallet"),
  weight: integer(1, 10_000, "this co-author's share in basis points; all weights must add up to 10000"),
  signature: optional(text("128 hex: this co-author's signature over the envelope the preview returned for this wallet; needed with send")),
});

const RECORDED_WHERE = ["release", "follow-up"] as const;

const recordedWhere: Schema<(typeof RECORDED_WHERE)[number] | false> = {
  json: {
    anyOf: [{ type: "string", enum: [...RECORDED_WHERE] }, { type: "boolean", const: false }],
    description:
      "where the sha256 was recorded: in a memo in the release, or in a follow-up transaction this wallet signed right after it because the release had no room for the memo; false when the follow-up failed, so the hash is not on chain",
  },
  read: (value, path) => (value === false ? false : choice(RECORDED_WHERE).read(value, path)),
};

export const walletAttestSplit = define({
  name: tool("wallet_attest_split"),
  title: "Release a proof escrow split among co-authors",
  description: `Pays several co-authors, split by weight, when this wallet is the escrow's attestor (judge). Each co-author signs the exact split: the preview returns what each signs; send with all their signatures. Changing a recipient, weight or result needs new signatures. A release cannot be undone. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    recipients: list(coauthor, MAX_SPLIT_RECIPIENTS, "the co-authors and their weighted shares, up to 8", 1),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    lookup_table: optional(account("an address lookup table holding this split's lookup_accounts, to fit more co-authors under the transaction size limit; create one with the preview's lookup_accounts and pass it with send")),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for; required, since a release recording it must include that work's earliest announcer among the recipients; recorded in a memo this wallet signs with the release, or right after it when the release has no room for the memo, so the payer can check what it receives with ${tool("wallet_receipt")}`)),
    max_pages: optional(integer(1, MAX_ATTEST_PAGES, MAX_PAGES_INPUT)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    digest: text("64 hex: the split digest every co-author and this wallet sign over"),
    envelope: text("the one message every co-author and this wallet sign, as hex; collect each co-author's signature over it"),
    lookup_accounts: list(account(), 24, "put these in an address lookup table (solana address-lookup-table create, then extend) and pass it as lookup_table to fit more co-authors"),
    paid: list(object({ wallet: account(), weight: amount(), amount: text("whole tokens this co-author receives") }), MAX_SPLIT_RECIPIENTS),
    net: text("whole tokens shared among the co-authors"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: optional(text("the sha256 the release records")),
    recorded: optional(recordedWhere),
    follow_up_signature: optional(text("the follow-up transaction that records the sha256, when recorded is follow-up")),
    record_memo: optional(text(`when recorded is false, the memo that records the sha256 for this release; ${tool("wallet_record_delivery")} sends it from this wallet with a zero transfer to the escrow`)),
    summary: list(text(), 12),
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
    if (!params.specHash.some((b) => b !== 0)) {
      throw new AgentRefusal("NotAProof", "a split release needs an escrow made with a spec_hash");
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
    const weights = input.recipients.map((r) => r.weight);
    if (weights.reduce((a, b) => a + b, 0) !== 10_000) {
      throw new InvalidInput([{ path: "recipients", message: SPLIT_WEIGHTS_WRONG }]);
    }
    const wallets = input.recipients.map((r) => r.wallet);
    for (const [i, r] of input.recipients.entries()) {
      await walletRecipient(ctx.transport, r.wallet, `recipients.${i}.wallet`);
    }
    if (input.delivered_sha256 === undefined) {
      throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
    }
    const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
    const record = await deliveryRecord(ctx.transport, signer.address, intent, input.max_pages ?? ATTEST_PAGES);
    if (!record.complete) {
      throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
    }
    const first = firstDelivery(record.deliveries, delivered);
    if (first !== null && !wallets.includes(first.worker)) {
      throw new AgentRefusal("NotEarliestAnnouncer", notInSplit(first.worker, delivered));
    }
    await confirmedRelease(ctx, { intent, attestor: signer.address, sha256: delivered, pages: input.max_pages ?? ATTEST_PAGES, payees: wallets });
    const memoText = releaseMemo(delivered);
    const memo = { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(memoText) };
    const token = await mintOf(ctx.transport, held.inputMint);
    const payees = await Promise.all(wallets.map((w) => tokenAccountIfMissing(ctx.transport, signer, w, held.inputMint, token.tokenProgram)));
    const amountIn = held.escrowed - held.filled;
    const settleAmount = amountIn - params.judgeFee;
    const maxFeeBps = held.feeBps + held.partnerBps;
    const shares = splitFees(settleAmount, held.feeBps, held.partnerBps, held.partnerCutBps);
    const payout = splitPayout(shares.net, weights);
    const treasury = shares.protocol > 0n ? await tokenAccountIfMissing(ctx.transport, signer, config.feeRecipient, held.inputMint, token.tokenProgram) : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner = partnerPaid ? await tokenAccountIfMissing(ctx.transport, signer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge = params.judgeFee > 0n ? await tokenAccountIfMissing(ctx.transport, signer, signer.address, held.inputMint, token.tokenProgram) : { create: [] };
    const splitHash = await splitCommit(wallets, weights);
    const fields = {
      domain: Uint8Array.from(config.domain),
      intent,
      amountIn,
      result,
      filled: held.filled,
      revision: held.revision,
      maxFeeBps,
      specHash: params.specHash,
      splitHash,
    };
    const message = await attestedSplitMessage(fields);
    const digestHex = getBase16Decoder().decode(Uint8Array.from(createHash("sha256").update(await attestedSplitPreimage(fields)).digest()));
    const settle = await buildFillAttestedSplit({
      solver: signer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      recipients: wallets,
      weights,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(partnerPaid ? { partner: held.partner } : {}),
      ...(params.judgeFee > 0n ? { judge: signer.address } : {}),
      amountIn,
      result,
      maxFeeBps,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const approval = approvalOf(message, memoText);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    let batch;
    if (input.send === true) {
      const entries = input.recipients.map((r, i) => {
        if (r.signature === undefined || !new RegExp(SIGNATURE_PATTERN).test(r.signature)) {
          throw new InvalidInput([{ path: `recipients.${i}.signature`, message: SPLIT_SIG_NEEDED }]);
        }
        return { publicKey: r.wallet, signature: Uint8Array.from(getBase16Encoder().encode(r.signature)) };
      });
      const attestorSignature = new Uint8Array(await signer.signBytes(message));
      batch = buildEd25519BatchInstruction({ entries: [...entries, { publicKey: signer.address, signature: attestorSignature }], message });
    }
    const setup = [...payees.flatMap((p) => p.create), ...treasury.create, ...partner.create, ...judge.create];
    const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, token.tokenProgram, signer.address]);
    const lookupAccounts = [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a));
    let tables: Record<Address, Address[]> | undefined;
    if (input.send === true && input.lookup_table !== undefined) {
      const view = await ctx.transport.getAccount(input.lookup_table);
      if (view === null) {
        throw new AgentRefusal("NotFound", `no lookup table ${input.lookup_table} on this cluster`);
      }
      tables = { [input.lookup_table]: decodeLookupTable(view.data) };
    }
    let prepared;
    let followUp = false;
    if (input.send === true && batch !== undefined) {
      const sizeOf = async (ixs: Parameters<typeof prepare>[1]) =>
        transactionSize(ctx.transport, await ctx.transport.budget(ixs, signer.address, tables), signer.address, tables);
      const bare = [...setup, batch, settle];
      followUp = (await sizeOf([...bare, memo])) > PACKET_DATA_SIZE;
      if (followUp) {
        const size = await sizeOf(bare);
        if (size > PACKET_DATA_SIZE) {
          throw new AgentRefusal("ReleaseTooLarge", splitTooLarge(size, input.recipients.length, input.lookup_table !== undefined));
        }
      }
      prepared = preparedView(await prepare(ctx.transport, followUp ? bare : [...bare, memo], signer.address, tables));
    }
    const view2 = {
      intent,
      digest: digestHex,
      envelope: getBase16Decoder().decode(message),
      lookup_accounts: lookupAccounts,
      paid: input.recipients.map((r, i) => ({
        wallet: r.wallet,
        weight: BigInt(r.weight),
        amount: formatAmount(payout[i] ?? 0n, token.decimals),
      })),
      net: formatAmount(shares.net, token.decimals),
      fee: formatAmount(shares.protocol + shares.partner + params.judgeFee, token.decimals),
      result,
      approval,
      delivered_sha256: delivered,
      summary: [
        `Splits: ${formatAmount(shares.net, token.decimals)} of ${name} among ${input.recipients.length} co-authors from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...input.recipients.map((r, i) => `  ${r.wallet}: ${r.weight} bps -> ${formatAmount(payout[i] ?? 0n, token.decimals)} of ${name}`),
        ...(params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        `Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`,
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        RECORDS_SPLIT(delivered),
        ...(setup.length === 0 ? [] : [`Setup: creates ${setup.length} token account(s), paid by this wallet`]),
      ],
      warnings: [...settlementWarnings(params), WARN_COAUTHORS],
      prepared,
    };
    const done = await sent(ctx, signer, view2, input.send, call, {
      preview: PREVIEW_APPROVAL_NEXT,
      done: `released to co-authors; ${tool("wallet_feedback")} to rate if you own it`,
    });
    if (!("signature" in done)) {
      return done;
    }
    if (!followUp) {
      return { ...done, recorded: "release" as const };
    }
    const unrecorded = (error: unknown) => ({
      ...done,
      recorded: false as const,
      record_memo: followUpMemo(delivered, done.signature),
      next: followUpFailed(problemOf(error).hint),
    });
    let recording;
    try {
      recording = preparedView(await prepare(ctx.transport, followUpInstructions(signer, intent, delivered, done.signature), signer.address));
    } catch (error) {
      return unrecorded(error);
    }
    try {
      return { ...done, recorded: "follow-up" as const, follow_up_signature: await execute(ctx.transport, recording, signer) };
    } catch (error) {
      if (neverLanded(error)) {
        return unrecorded(error);
      }
      const landed = await ctx.transport
        .engineTransactions(WAIT_SCAN, intent)
        .then((transactions) => followUpOf(transactions, done.signature, signer.address))
        .catch(() => null);
      return landed === null || landed.sha256 !== delivered ? unrecorded(error) : { ...done, recorded: "follow-up" as const, follow_up_signature: landed.signature };
    }
  },
});
