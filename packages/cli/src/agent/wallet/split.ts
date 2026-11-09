import { type Address, getBase16Decoder, getBase16Encoder, type Instruction } from "@solana/kit";
import { formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS, MAX_SPLIT_RECIPIENTS, settlementWarnings } from "@intent-engine/core/internal";
import { decodeLookupTable } from "@intent-engine/solver";
import { createClient } from "@intent-engine/client/node";
import { type CoSignature, mintOf, PACKET_DATA_SIZE, type ReleasePreview, releaseReads, type SplitShare, splitPreview } from "@intent-engine/client/internal";
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
import { prepare } from "../prepare.js";
import { fitted, sizeOf } from "./release-size.js";
import { feePayerOf, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners, type WalletSigner } from "./guard.js";
import { firstOpeningFor, skippedField, skippedOutput } from "./openings.js";
import {
  approvalOf,
  attestedEscrow,
  claimsOfRelease,
  DEVICE_RELEASE,
  feeFigures,
  feeLines,
  feeOutputs,
  invitedPayees,
  NEEDS_RECEIPT,
  RELEASE_CHANGED,
  settleRefused,
  stakeReturned,
  uncheckedOutput,
  walletAuthority,
  withoutReceipt,
} from "./attest.js";
import { boundApproval, recorded } from "../../receipt-gate.js";
import { sol, tokenAccountRent } from "./costs.js";
import { confirmedRelease } from "./delivery.js";

export async function setupLine(ctx: AgentContext, count: number, tokenProgram: Address, device: boolean): Promise<string> {
  const rent = await tokenAccountRent(ctx.transport, tokenProgram);
  return `Setup: creates ${count} token account(s), paid by ${device ? "the fee payer" : "this wallet"}: ${sol(rent)} of rent each, ${sol(rent * BigInt(count))} in all`;
}

export { fitted, sizeOf } from "./release-size.js";

export const SPLIT_FITS = 1;
export const SPLIT_FITS_WITH_TABLE = 4;
const coauthors = (count: number): string => (count === 1 ? "1 co-author" : `${count} co-authors`);
export const fitsHint = (bare: number, tabled: number, whatever: string, withTable: boolean): string =>
  `whatever ${whatever}, a release at no priority fee fits ${coauthors(bare)} without a lookup table and ${coauthors(tabled)} with one${withTable ? ", so reduce recipients" : ", so pass lookup_table with the preview's lookup_accounts to fit more, or reduce recipients"}`;
export const overLimit = (what: string, size: number, withTable: boolean): string =>
  `${what} builds a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit${withTable ? " even with the lookup table" : ""}`;
export const splitTooLarge = (size: number, recipients: number, withTable: boolean): string =>
  `${overLimit(`this ${recipients}-co-author split`, size, withTable)}; ${fitsHint(SPLIT_FITS, SPLIT_FITS_WITH_TABLE, "claims, partner and mint cap accounts the escrow carries", withTable)}`;
export const SPLIT_WEIGHTS_WRONG = "the weights must be whole basis points that add up to 10000";
export const SPLIT_SIG_NEEDED = "every co-author must sign the split before send: true; preview returns the envelope each one signs";
export const SIGNATURE_PATTERN = "^[0-9a-fA-F]{128}$";
export const WARN_COAUTHORS = "every co-author must sign the exact split; a release pays only the recipients and weights they all signed";

export const willHold = (wallets: readonly string[]) =>
  `${wallets.join(", ")} cannot take a payout into its token account now, so the release pays the others and holds that share in the escrow until its co-author claims it with ${tool("wallet_claim_held")}`;

export const notInSplit = (worker: string, sha256: string) =>
  `${worker} made the first announcement that opens to the work with sha256 ${sha256}, so a split paying for it must include ${worker} among its recipients`;

export const share = {
  wallet: account("the co-author's wallet"),
  weight: integer(1, 10_000, "this co-author's share in basis points; all weights must add up to 10000"),
};

export const coauthor = object({
  ...share,
  signature: optional(text("128 hex: this co-author's signature over the envelope the preview returned; needed with send")),
});

export const paidOutput = list(object({ wallet: account(), weight: amount(), amount: text("whole tokens this co-author receives") }), MAX_SPLIT_RECIPIENTS);

export const lookupOutput = list(account(), 24, "put these in an address lookup table and pass it as lookup_table to fit more co-authors");

export const lookupInput = account(
  "an address lookup table holding this split's lookup_accounts, to fit more co-authors under the transaction size limit; create one with the preview's lookup_accounts and pass it with send",
);

type Shares = readonly { wallet: Address; weight: number }[];

export async function checkedShares(ctx: AgentContext, recipients: Shares): Promise<SplitShare[]> {
  if (recipients.reduce((sum, r) => sum + r.weight, 0) !== 10_000) {
    throw new InvalidInput([{ path: "recipients", message: SPLIT_WEIGHTS_WRONG }]);
  }
  for (const [i, r] of recipients.entries()) {
    await walletRecipient(ctx.transport, r.wallet, `recipients.${i}.wallet`);
  }
  return recipients.map(({ wallet, weight }) => ({ wallet, weight }));
}

export async function coSignatures(
  signer: WalletSigner,
  recipients: readonly { wallet: Address; signature?: string | undefined }[],
  message: Uint8Array,
  missing = SPLIT_SIG_NEEDED,
  keepGiven = false,
): Promise<CoSignature[]> {
  return Promise.all(
    recipients.map(async (r, i) => {
      if (r.wallet === signer.address && !(keepGiven && r.signature !== undefined)) {
        return { wallet: r.wallet, signature: new Uint8Array(await signer.signBytes(message)) };
      }
      if (r.signature === undefined || !new RegExp(SIGNATURE_PATTERN).test(r.signature)) {
        throw new InvalidInput([{ path: `recipients.${i}.signature`, message: missing }]);
      }
      return { wallet: r.wallet, signature: Uint8Array.from(getBase16Encoder().encode(r.signature)) };
    }),
  );
}

export async function lookupTablesOf(ctx: AgentContext, table: Address | undefined): Promise<Record<Address, Address[]> | undefined> {
  if (table === undefined) {
    return undefined;
  }
  const view = await ctx.transport.getAccount(table);
  if (view === null) {
    throw new AgentRefusal("NotFound", `no lookup table ${table} on this cluster`);
  }
  return { [table]: decodeLookupTable(view.data) };
}

export function lookupAccountsOf(settle: Instruction, tokenProgram: Address, payer: Address): Address[] {
  const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, tokenProgram, payer]);
  return [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a));
}

export const paidShares = (release: ReleasePreview, recipients: Shares, decimals: number) =>
  recipients.map((r, i) => ({ wallet: r.wallet, weight: BigInt(r.weight), amount: formatAmount(release.payees[i]?.amount ?? 0n, decimals) }));

export const shareLines = (release: ReleasePreview, recipients: Shares, name: string, decimals: number): string[] =>
  paidShares(release, recipients, decimals).map((r) => `  ${r.wallet}: ${r.weight} bps -> ${r.amount} of ${name}`);

export const committeeFees = (release: ReleasePreview, feeWallet: Address, name: string, decimals: number): string[] =>
  release.fees.flatMap((leg) =>
    leg.role === "judge" && leg.paid
      ? [`Pays the judge fee: ${formatAmount(leg.amount, decimals)} of ${name} to the committee's fee wallet ${feeWallet}, carved out of the escrow`]
      : feeLines({ ...release, fees: [leg] }, name, decimals),
  );

export const heldWarnings = (release: ReleasePreview): string[] => {
  const holding = release.payees.filter((payee) => !payee.accepts).map((payee) => payee.wallet);
  return holding.length === 0 ? [] : [willHold(holding)];
};

export const walletAttestSplit = define({
  name: tool("wallet_attest_split"),
  title: "Release a proof escrow split among co-authors",
  description: `Pays co-authors by weight when this wallet is the escrow's attestor (judge); one must have made the first announcement that opens to delivered_sha256. The preview returns what each co-author signs; send with all their signatures. A release cannot be undone. ${NEEDS_RECEIPT} ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    recipients: list(coauthor, MAX_SPLIT_RECIPIENTS, "the co-authors and their weighted shares, up to 8", 1),
    delivered_sha256: text(`the sha256, as 64 hex digits, of the work this release pays for, as ${tool("wallet_fetch_work")} shows it`),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    lookup_table: optional(lookupInput),
    without_receipt: withoutReceipt,
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    announcement: account("the announcement the release pays"),
    seq: amount(),
    digest: text("64 hex: the split digest every co-author and this wallet sign over"),
    envelope: text("the one message every co-author and this wallet sign, as hex; collect each co-author's signature over it"),
    lookup_accounts: lookupOutput,
    paid: paidOutput,
    net: text("whole tokens shared among the co-authors"),
    ...feeOutputs,
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: text("the sha256 of the work the release pays for"),
    skipped: skippedOutput,
    unchecked: uncheckedOutput,
    summary: list(text(), 22),
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
    const { intent, held, params } = escrow;
    if (!params.specHash.some((b) => b !== 0)) {
      throw new AgentRefusal("NotAProof", "a split release needs an escrow made with a spec_hash");
    }
    const result = input.result ?? params.minResult;
    if (result < params.minResult || result > params.maxResult) {
      throw new InvalidInput([{ path: "result", message: `must be between ${params.minResult} and ${params.maxResult}` }]);
    }
    const shares = await checkedShares(ctx, input.recipients);
    const wallets = shares.map((r) => r.wallet);
    const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
    const { opening, skipped } = await firstOpeningFor(ctx, signer.address, intent, delivered, device);
    if (!wallets.includes(opening.worker)) {
      throw new AgentRefusal("NotEarliestAnnouncer", notInSplit(opening.worker, delivered));
    }
    const at = { owner: input.owner, nonce: input.nonce, intent, deliveredSha256: delivered, announcement: opening.announcement };
    const authority = await walletAuthority(ctx, at, [signer.address], input.without_receipt);
    await invitedPayees(ctx, intent, wallets);
    const claimed = await claimsOfRelease(ctx, intent, held.claims, wallets);
    const left = claimed.accounts.claims === undefined ? undefined : await boardLeft(ctx.transport, input.owner, input.nonce, intent);
    await confirmedRelease(ctx, { intent, attestor: signer.address, sha256: delivered, payees: wallets, keypair: await walletOpeners(ctx) });
    const target = { intent: { owner: input.owner, nonce: input.nonce }, announcement: opening.announcement, opening: { sha256: delivered, salt: opening.salt }, result, recipients: shares };
    const { ballot, preview: release, settle } = await splitPreview(releaseReads(ctx.transport), target, payer).catch(settleRefused);
    const token = await mintOf(ctx.transport, held.inputMint);
    const digestHex = getBase16Decoder().decode(ballot.digest).toLowerCase();
    const approval = boundApproval(approvalOf(input.lookup_table === undefined ? ballot.message : Uint8Array.from([...ballot.message, ...new TextEncoder().encode(input.lookup_table)])), authority);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const { setup } = release;
    let prepared;
    if (input.send === true) {
      const signatures = await coSignatures(signer, input.recipients, ballot.message);
      const tables = await lookupTablesOf(ctx, input.lookup_table);
      const plan = await createClient({ url: ctx.url ?? "", transport: ctx.transport }).plan.settleSplit({ ...target, judge: signer, signatures, payer }).catch(settleRefused);
      const instructions = await fitted(ctx, plan.instructions, payer.address, tables, (size) => splitTooLarge(size, shares.length, tables !== undefined));
      if (plan.setup.length > 0) {
        await execute(ctx.transport, preparedView(await prepare(ctx.transport, plan.setup, payer.address)), payer);
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
      lookup_accounts: lookupAccountsOf(settle, token.tokenProgram, payer.address),
      paid: paidShares(release, shares, token.decimals),
      net: formatAmount(release.net, token.decimals),
      ...feeFigures(release, token.decimals),
      result,
      approval,
      delivered_sha256: delivered,
      ...skippedField(skipped),
      ...recorded(authority),
      summary: [
        `Splits: ${formatAmount(release.net, token.decimals)} of ${name} among ${shares.length} co-authors from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...shareLines(release, shares, name, token.decimals),
        `For: the work with sha256 ${delivered}, announced by ${opening.worker} in ${opening.announcement} (seq ${opening.seq}), the first that opens to it`,
        ...feeLines(release, name, token.decimals),
        `Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`,
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(device ? [`Signs: only the release message on the Ledger, which shows digest ${digestHex}; the fee payer ${payer.address} signs and pays the transaction`] : []),
        ...stakeReturned(claimed.stake, claimed.accounts.stakeTo),
        ...leavesBoard(left),
        ...(setup.length === 0 ? [] : [`${await setupLine(ctx, setup.length, token.tokenProgram, device)}, in its own transaction before the release`]),
      ],
      warnings: [...settlementWarnings(params), WARN_COAUTHORS, ...heldWarnings(release)],
      prepared,
    };
    return sent(ctx, payer, view, input.send, call, {
      preview: device ? `${PREVIEW_APPROVAL_NEXT}; ${DEVICE_RELEASE}` : PREVIEW_APPROVAL_NEXT,
      done: thenSettle(`released to co-authors; ${tool("wallet_feedback")} to rate if you own it`, left),
    });
  },
});
