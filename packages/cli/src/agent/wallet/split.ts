import { type Address, getBase16Decoder, getBase16Encoder } from "@solana/kit";
import { formatAmount, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { buildFillAttestedSplit, INTENT_ENGINE_PROGRAM_ADDRESS, MAX_SPLIT_RECIPIENTS, splitPayout, settlementWarnings } from "@intent-engine/core/internal";
import { decodeLookupTable } from "@intent-engine/solver";
import { createClient } from "@intent-engine/client/node";
import { acceptsPayout, mintOf, PACKET_DATA_SIZE, tokenAccountIfMissing } from "@intent-engine/client/internal";
import { execute } from "../../flows.js";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { WRAPPED } from "../create.js";
import { tool } from "../names.js";
import { boardLeft, leavesBoard, thenSettle } from "../claim-line.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { walletRecipient } from "../owner.js";
import { prepare, transactionSize } from "../prepare.js";
import { feePayerOf, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";
import { firstOpeningFor, skippedField, skippedOutput } from "./openings.js";
import { approvalOf, attestedEscrow, capturedSends, claimsOfRelease, DEVICE_RELEASE, invitedPayees, RELEASE_CHANGED, settleRefused, stakeReturned } from "./attest.js";
import { sol, tokenAccountRent } from "./costs.js";
import { confirmedRelease } from "./delivery.js";

async function setupLine(ctx: AgentContext, count: number, tokenProgram: Address, device: boolean): Promise<string> {
  const rent = await tokenAccountRent(ctx.transport, tokenProgram);
  return `Setup: creates ${count} token account(s), paid by ${device ? "the fee payer" : "this wallet"}: ${sol(rent)} of rent each, ${sol(rent * BigInt(count))} in all`;
}

export const SPLIT_FITS = 2;
export const SPLIT_FITS_WITH_TABLE = 4;
export const splitTooLarge = (size: number, recipients: number, withTable: boolean): string =>
  `this ${recipients}-co-author split builds a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit${withTable ? " even with the lookup table" : ""}; a release at no priority fee fits ${SPLIT_FITS} co-authors without a lookup table and ${SPLIT_FITS_WITH_TABLE} with one${withTable ? ", so reduce recipients or pay the rest in a second release" : ", so pass lookup_table with the preview's lookup_accounts to fit more, or reduce recipients"}`;
export const SPLIT_WEIGHTS_WRONG = "the weights must be whole basis points that add up to 10000";
export const SPLIT_SIG_NEEDED = "every co-author must sign the split before send: true; preview returns the envelope each one signs";
export const SIGNATURE_PATTERN = "^[0-9a-fA-F]{128}$";
export const WARN_COAUTHORS = "every co-author must sign the exact split; a release pays only the recipients and weights they all signed";

export const willHold = (wallets: readonly string[]) =>
  `${wallets.join(", ")} cannot take a payout into its token account now, so the release pays the others and holds that share in the escrow until its co-author claims it with ${tool("wallet_claim_held")}`;

export const notInSplit = (worker: string, sha256: string) =>
  `${worker} made the first announcement that opens to the work with sha256 ${sha256}, so a split paying for it must include ${worker} among its recipients`;

const coauthor = object({
  wallet: account("the co-author's wallet"),
  weight: integer(1, 10_000, "this co-author's share in basis points; all weights must add up to 10000"),
  signature: optional(text("128 hex: this co-author's signature over the envelope the preview returned; needed with send")),
});

export const walletAttestSplit = define({
  name: tool("wallet_attest_split"),
  title: "Release a proof escrow split among co-authors",
  description: `Pays co-authors by weight when this wallet is the escrow's attestor (judge); one must have made the first announcement that opens to delivered_sha256. The preview returns what each co-author signs; send with all their signatures. A release cannot be undone. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    recipients: list(coauthor, MAX_SPLIT_RECIPIENTS, "the co-authors and their weighted shares, up to 8", 1),
    delivered_sha256: text(`the sha256, as 64 hex digits, of the work this release pays for, as ${tool("wallet_fetch_work")} shows it`),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    lookup_table: optional(account("an address lookup table holding this split's lookup_accounts, to fit more co-authors under the transaction size limit; create one with the preview's lookup_accounts and pass it with send")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    announcement: account("the announcement the release pays"),
    seq: amount(),
    digest: text("64 hex: the split digest every co-author and this wallet sign over"),
    envelope: text("the one message every co-author and this wallet sign, as hex; collect each co-author's signature over it"),
    lookup_accounts: list(account(), 24, "put these in an address lookup table and pass it as lookup_table to fit more co-authors"),
    paid: list(object({ wallet: account(), weight: amount(), amount: text("whole tokens this co-author receives") }), MAX_SPLIT_RECIPIENTS),
    net: text("whole tokens shared among the co-authors"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: text("the sha256 of the work the release pays for"),
    skipped: skippedOutput,
    summary: list(text(), 18),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const device = signer.device !== undefined;
    const payer = device ? await feePayerOf(ctx) : signer;
    const escrow = await attestedEscrow(ctx, input.owner, input.nonce, signer);
    const { intent, held, params, config } = escrow;
    if (!params.specHash.some((b) => b !== 0)) {
      throw new AgentRefusal("NotAProof", "a split release needs an escrow made with a spec_hash");
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
    const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
    const { opening, skipped } = await firstOpeningFor(ctx, signer.address, intent, delivered, device);
    if (!wallets.includes(opening.worker)) {
      throw new AgentRefusal("NotEarliestAnnouncer", notInSplit(opening.worker, delivered));
    }
    await invitedPayees(ctx, intent, wallets);
    const claimed = await claimsOfRelease(ctx, intent, held.claims, wallets);
    const left = claimed.accounts.claims === undefined ? undefined : await boardLeft(ctx.transport, input.owner, input.nonce, intent);
    await confirmedRelease(ctx, { intent, attestor: signer.address, sha256: delivered, payees: wallets, keypair: await walletOpeners(ctx) });
    const shares = input.recipients.map(({ wallet, weight }) => ({ wallet, weight }));
    const target = { intent: { owner: input.owner, nonce: input.nonce }, announcement: opening.announcement, opening: { sha256: delivered, salt: opening.salt }, result, recipients: shares };
    const ballot = await createClient({ url: ctx.url ?? "", transport: ctx.transport }).splitBallot(target).catch(settleRefused);
    const token = await mintOf(ctx.transport, held.inputMint);
    const payees = await Promise.all(wallets.map((w) => tokenAccountIfMissing(ctx.transport, payer, w, held.inputMint, token.tokenProgram)));
    const holding: Address[] = [];
    for (const [i, payee] of payees.entries()) {
      const wallet = wallets[i];
      if (wallet !== undefined && payee.create.length === 0 && !acceptsPayout(await ctx.transport.getAccount(payee.address), token.tokenProgram, held.inputMint, wallet)) {
        holding.push(wallet);
      }
    }
    const amountIn = held.escrowed - held.filled;
    const maxFeeBps = held.feeBps + held.partnerBps;
    const fees = splitFees(amountIn - params.judgeFee, held.feeBps, held.partnerBps, held.partnerCutBps);
    const payout = splitPayout(fees.net, weights);
    const treasury = fees.protocol > 0n ? await tokenAccountIfMissing(ctx.transport, payer, config.feeRecipient, held.inputMint, token.tokenProgram) : { create: [] };
    const partner = fees.partner > 0n ? await tokenAccountIfMissing(ctx.transport, payer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge = params.judgeFee > 0n ? await tokenAccountIfMissing(ctx.transport, payer, signer.address, held.inputMint, token.tokenProgram) : { create: [] };
    const settle = await buildFillAttestedSplit({
      solver: payer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      recipients: wallets,
      weights,
      ...(fees.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(fees.partner > 0n ? { partner: held.partner } : {}),
      ...(params.judgeFee > 0n ? { judge: signer.address } : {}),
      ...claimed.accounts,
      announcement: opening.announcement,
      opening: { delivered: Uint8Array.from(Buffer.from(delivered, "hex")), salt: Uint8Array.from(Buffer.from(opening.salt, "hex")) },
      amountIn,
      result,
      maxFeeBps,
      capped: held.capped,
    });
    const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, token.tokenProgram, payer.address]);
    const lookupAccounts = [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a));
    const digestHex = getBase16Decoder().decode(ballot.digest).toLowerCase();
    const approval = approvalOf(ballot.message);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const setup = [...payees.flatMap((p) => p.create), ...treasury.create, ...partner.create, ...judge.create];
    let prepared;
    if (input.send === true) {
      const signatures = await Promise.all(
        input.recipients.map(async (r, i) => {
          if (r.wallet === signer.address) {
            return { wallet: r.wallet, signature: new Uint8Array(await signer.signBytes(ballot.message)) };
          }
          if (r.signature === undefined || !new RegExp(SIGNATURE_PATTERN).test(r.signature)) {
            throw new InvalidInput([{ path: `recipients.${i}.signature`, message: SPLIT_SIG_NEEDED }]);
          }
          return { wallet: r.wallet, signature: Uint8Array.from(getBase16Encoder().encode(r.signature)) };
        }),
      );
      let tables: Record<Address, Address[]> | undefined;
      if (input.lookup_table !== undefined) {
        const view = await ctx.transport.getAccount(input.lookup_table);
        if (view === null) {
          throw new AgentRefusal("NotFound", `no lookup table ${input.lookup_table} on this cluster`);
        }
        tables = { [input.lookup_table]: decodeLookupTable(view.data) };
      }
      const sends = await capturedSends(ctx, (client) => client.settleSplit({ ...target, judge: signer, signatures, payer }));
      const instructions = sends.at(-1) ?? [];
      const size = await transactionSize(ctx.transport, await ctx.transport.budget(instructions, payer.address, tables), payer.address, tables);
      if (size > PACKET_DATA_SIZE) {
        throw new AgentRefusal("ReleaseTooLarge", splitTooLarge(size, input.recipients.length, input.lookup_table !== undefined));
      }
      for (const accounts of sends.slice(0, -1)) {
        await execute(ctx.transport, preparedView(await prepare(ctx.transport, accounts, payer.address)), payer);
      }
      prepared = preparedView(await prepare(ctx.transport, instructions, payer.address, tables));
    }
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const view = {
      intent,
      announcement: opening.announcement,
      seq: opening.seq,
      digest: digestHex,
      envelope: getBase16Decoder().decode(ballot.message).toLowerCase(),
      lookup_accounts: lookupAccounts,
      paid: input.recipients.map((r, i) => ({ wallet: r.wallet, weight: BigInt(r.weight), amount: formatAmount(payout[i] ?? 0n, token.decimals) })),
      net: formatAmount(fees.net, token.decimals),
      fee: formatAmount(fees.protocol + fees.partner + params.judgeFee, token.decimals),
      result,
      approval,
      delivered_sha256: delivered,
      ...skippedField(skipped),
      summary: [
        `Splits: ${formatAmount(fees.net, token.decimals)} of ${name} among ${input.recipients.length} co-authors from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...input.recipients.map((r, i) => `  ${r.wallet}: ${r.weight} bps -> ${formatAmount(payout[i] ?? 0n, token.decimals)} of ${name}`),
        `For: the work with sha256 ${delivered}, announced by ${opening.worker} in ${opening.announcement} (seq ${opening.seq}), the first that opens to it`,
        ...(params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        `Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`,
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(device ? [`Signs: only the release message on the Ledger, which shows digest ${digestHex}; the fee payer ${payer.address} signs and pays the transaction`] : []),
        ...stakeReturned(claimed.stake, claimed.accounts.stakeTo),
        ...leavesBoard(left),
        ...(setup.length === 0 ? [] : [`${await setupLine(ctx, setup.length, token.tokenProgram, device)}, in its own transaction before the release`]),
      ],
      warnings: [...settlementWarnings(params), WARN_COAUTHORS, ...(holding.length === 0 ? [] : [willHold(holding)])],
      prepared,
    };
    return sent(ctx, payer, view, input.send, call, {
      preview: device ? `${PREVIEW_APPROVAL_NEXT}; ${DEVICE_RELEASE}` : PREVIEW_APPROVAL_NEXT,
      done: thenSettle(`released to co-authors; ${tool("wallet_feedback")} to rate if you own it`, left),
    });
  },
});
