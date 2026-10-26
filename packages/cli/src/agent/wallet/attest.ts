import { createHash } from "node:crypto";
import { type Address, getAddressDecoder, getBase16Decoder, type Instruction } from "@solana/kit";
import { formatAmount, IntentStatus, Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import {
  attestedFillMessage,
  buildEd25519Instruction,
  buildFillAttested,
  COMPUTE_BUDGET_ADDRESS,
  decodeIntentAccount,
  decodeParams,
  findIntentPda,
  formatTime,
  settlementWarnings,
} from "@intent-engine/core/internal";
import { type BallotInput, isSdkError } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { chainTime, envelopeDigest, loadConfig, mintOf, releaseClaims, tokenAccountIfMissing } from "@intent-engine/client/internal";
import { capturing, skippedSummary } from "../../announcement-views.js";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define, specReach } from "../actions.js";
import type { Call } from "../claims.js";
import { WRAPPED } from "../create.js";
import { tool } from "../names.js";
import { boardLeft, leavesBoard, thenSettle } from "../claim-line.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { sol, tokenAccountRent } from "./costs.js";
import { walletRecipient } from "../owner.js";
import { prepare } from "../prepare.js";
import { STATUS } from "../../accounts.js";
import { feePayerOf, PREVIEW_APPROVAL, PREVIEW_APPROVAL_NEXT, signerOf, sent, sha256Of, walletOpeners, type WalletSigner } from "./guard.js";
import { firstOpeningFor, skippedField, skippedOutput } from "./openings.js";
import { checkInvited, InviteRefused } from "../../invites.js";
import { confirmedRelease, DELIVERED_NEEDED, notAttestor } from "./delivery.js";

export const RESULT_MEANS =
  "the plain count the attestor signs, between the escrow's min_result and max_result; it does not change the amount paid. On a proof escrow it records that the work passed the spec, and is 1 unless the escrow allows a range";

export const PAYEE_MOVED = "this wallet's token account for the escrowed token now belongs to someone else, so a release would not reach it; ask the payee for another wallet";

export const RELEASE_CHANGED = "this release differs from its preview: the payee, amount, result, fee or the escrow itself changed, or no approval was given; preview it again and show the user";

export const DEVICE_DIGEST = "the digest the Ledger shows when it signs the release message: compare the two before approving on the device";

export const DEVICE_RELEASE = "the Ledger shows digest when it signs the release message: show it to the user, who approves on the device only if its screen shows the same digest";

export const PAY_TO_NEEDED = "an attested escrow without a spec hash pays the wallet its attestor names, so give pay_to";

export const notEarliest = (worker: string, sha256: string) =>
  `${worker} made the first announcement that opens to the work with sha256 ${sha256}, so a release for that work pays ${worker}; leave pay_to out on a proof escrow`;

export const claimHeldBy = (worker: Address, until: bigint) =>
  `${worker} holds this job's claim until ${formatTime(until)}, so only that worker can be paid until then; nothing was sent`;

export async function claimsOfRelease(ctx: AgentContext, intent: Address, claims: number, payees: readonly Address[]) {
  try {
    return await releaseClaims(ctx.transport, intent, claims, payees);
  } catch (error) {
    if (isSdkError(error, "claim-held-by")) {
      throw new AgentRefusal("ClaimHeld", claimHeldBy(error.worker, error.until));
    }
    throw error;
  }
}

export async function invitedPayees(ctx: AgentContext, intent: Address, payees: readonly Address[]): Promise<void> {
  try {
    await checkInvited(ctx.transport, ctx.fetch ?? fetch, intent, payees, specReach(ctx));
  } catch (error) {
    throw error instanceof InviteRefused ? new AgentRefusal(error.code, error.hint, error.detail) : error;
  }
}

export function settleRefused(error: unknown): never {
  if (isSdkError(error, "claim-held-by")) {
    throw new AgentRefusal("ClaimHeld", claimHeldBy(error.worker, error.until));
  }
  if (isSdkError(error, "payee-moved")) {
    throw new InvalidInput([{ path: "delivered_sha256", message: PAYEE_MOVED }]);
  }
  if (isSdkError(error, "not-settleable")) {
    throw new AgentRefusal("KindMismatch", error.message);
  }
  throw error;
}

export const stakeReturned = (stake: bigint, stakeTo: Address | undefined): string[] =>
  stakeTo === undefined || stake === 0n ? [] : [`Returns: the claim stake of ${formatAmount(stake, 9)} SOL to ${stakeTo}`];

export const approvalOf = (message: Uint8Array): string => createHash("sha256").update(message).digest("hex").slice(0, 16);

export async function capturedSends(ctx: AgentContext, settle: (client: ReturnType<typeof createClient>) => Promise<unknown>): Promise<Instruction[][]> {
  const probe = capturing(ctx.transport);
  await settle(createClient({ url: ctx.url ?? "", transport: probe.transport })).catch(settleRefused);
  return probe.sends.map(({ instructions }) => instructions.filter((ix) => ix.programAddress !== COMPUTE_BUDGET_ADDRESS));
}

export async function capturedSettle(ctx: AgentContext, settle: (client: ReturnType<typeof createClient>) => Promise<unknown>): Promise<Instruction[]> {
  return (await capturedSends(ctx, settle)).flat();
}

type Escrow = Awaited<ReturnType<typeof attestedEscrow>>;

export async function attestedEscrow(ctx: AgentContext, owner: Address, nonce: bigint, signer: WalletSigner) {
  const [intent] = await findIntentPda({ owner, nonce });
  const [view, { config }] = await Promise.all([ctx.transport.getAccount(intent), loadConfig(ctx.transport)]);
  if (view === null) {
    throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled, cancelled and closed, or never made`);
  }
  const held = decodeIntentAccount(view.data);
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
  return { intent, held, params, config };
}

async function proofTarget(ctx: AgentContext, escrow: Escrow, input: { owner: Address; nonce: bigint; delivered_sha256?: string | undefined; pay_to?: Address | undefined }, signer: WalletSigner, result: bigint) {
  if (input.delivered_sha256 === undefined) {
    throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
  }
  const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
  const { opening, skipped } = await firstOpeningFor(ctx, signer.address, escrow.intent, delivered, signer.device !== undefined);
  if (input.pay_to !== undefined && input.pay_to !== opening.worker) {
    throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(opening.worker, delivered));
  }
  const target: BallotInput = { intent: { owner: input.owner, nonce: input.nonce }, announcement: opening.announcement, opening: { sha256: delivered, salt: opening.salt }, result };
  return { delivered, opening, skipped, target };
}

export const walletAttest = define({
  name: tool("wallet_attest"),
  title: "Release an escrow as its attestor",
  description: `Pays for approved work when this wallet is the escrow's attestor (judge): a proof escrow pays the first announcement that opens to delivered_sha256, any other attested escrow pays pay_to. A release cannot be undone; the approval holds the send to the preview. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for, as ${tool("wallet_fetch_work")} shows it; required for a proof escrow`)),
    pay_to: optional(account("the wallet to pay, only for an attested escrow without a spec hash; a proof escrow pays its announcing worker")),
    result: optional(amount("the result to attest, a plain count not whole tokens, between the intent's min_result and max_result; default min_result")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    pay_to: account("the wallet this release pays"),
    payee: account("pay_to's token account for the escrowed token, where the tokens land; for SOL it holds wrapped SOL"),
    paid: text("whole tokens pay_to receives"),
    fee: text("whole tokens kept as fees"),
    result: amount(RESULT_MEANS),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    digest: optional(text(DEVICE_DIGEST)),
    delivered_sha256: optional(text("the sha256 of the work the release pays for")),
    announcement: optional(account("the announcement the release pays")),
    seq: optional(amount("its place among the escrow's announcements")),
    skipped: skippedOutput,
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
    const escrow = await attestedEscrow(ctx, input.owner, input.nonce, signer);
    const { intent, held, params, config } = escrow;
    const result = input.result ?? params.minResult;
    if (result < params.minResult || result > params.maxResult) {
      throw new InvalidInput([{ path: "result", message: `must be between ${params.minResult} and ${params.maxResult}` }]);
    }
    const isProof = params.specHash.some((b) => b !== 0);
    const proof = isProof ? await proofTarget(ctx, escrow, input, signer, result) : undefined;
    const payTo = proof?.opening.worker ?? input.pay_to;
    if (payTo === undefined) {
      throw new InvalidInput([{ path: "pay_to", message: PAY_TO_NEEDED }]);
    }
    await walletRecipient(ctx.transport, payTo, "pay_to");
    await invitedPayees(ctx, intent, [payTo]);
    const claimed = await claimsOfRelease(ctx, intent, held.claims, [payTo]);
    const left = claimed.accounts.claims === undefined ? undefined : await boardLeft(ctx.transport, input.owner, input.nonce, intent);
    const token = await mintOf(ctx.transport, held.inputMint);
    const payee = await tokenAccountIfMissing(ctx.transport, payer, payTo, held.inputMint, token.tokenProgram);
    if (payee.create.length === 0) {
      const existing = await ctx.transport.getAccount(payee.address);
      const holder = existing === null || existing.data.length < 64 ? null : getAddressDecoder().decode(existing.data.subarray(32, 64));
      if (holder !== payTo) {
        throw new InvalidInput([{ path: isProof ? "delivered_sha256" : "pay_to", message: PAYEE_MOVED }]);
      }
    }
    const amountIn = held.escrowed - held.filled;
    const maxFeeBps = held.feeBps + held.partnerBps;
    const shares = splitFees(amountIn - params.judgeFee, held.feeBps, held.partnerBps, held.partnerCutBps);
    const treasury = shares.protocol > 0n ? await tokenAccountIfMissing(ctx.transport, payer, config.feeRecipient, held.inputMint, token.tokenProgram) : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner = partnerPaid ? await tokenAccountIfMissing(ctx.transport, payer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge = isProof && params.judgeFee > 0n ? await tokenAccountIfMissing(ctx.transport, payer, signer.address, held.inputMint, token.tokenProgram) : { create: [] };
    const setup = [...payee.create, ...treasury.create, ...partner.create, ...judge.create];
    let message: Uint8Array;
    let instructions: () => Promise<Instruction[]>;
    if (proof !== undefined) {
      await confirmedRelease(ctx, { intent, attestor: signer.address, sha256: proof.delivered, payees: [payTo], keypair: await walletOpeners(ctx) });
      message = (await createClient({ url: ctx.url ?? "", transport: ctx.transport }).proofBallot(proof.target).catch(settleRefused)).message;
      instructions = () => capturedSettle(ctx, (client) => client.settleProof({ judge: signer, payer, ...proof.target }));
    } else {
      const fields = { domain: Uint8Array.from(config.domain), intent, payee: payee.address, amountIn, result, filled: held.filled, revision: held.revision, maxFeeBps };
      message = await attestedFillMessage(signer.address, fields);
      const settle = await buildFillAttested({
        solver: payer,
        owner: input.owner,
        nonce: input.nonce,
        inputMint: held.inputMint,
        inputTokenProgram: token.tokenProgram,
        payee: payee.address,
        ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
        ...(partnerPaid ? { partner: held.partner } : {}),
        ...claimed.accounts,
        amountIn,
        result,
        maxFeeBps,
        capped: held.capped,
      });
      const signed = message;
      instructions = async () => [...setup, buildEd25519Instruction({ publicKey: signer.address, signature: await signer.signBytes(signed), message: signed }), settle];
    }
    const approval = approvalOf(message);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const prepared = input.send === true ? preparedView(await prepare(ctx.transport, await instructions(), payer.address)) : undefined;
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const paid = formatAmount(shares.net, token.decimals);
    const paidBy = `${device ? "the fee payer" : "this wallet"}: ${setup.length === 0 ? "" : sol(await tokenAccountRent(ctx.transport, token.tokenProgram))} of rent`;
    const view = {
      intent,
      pay_to: payTo,
      payee: payee.address,
      paid,
      fee: formatAmount(shares.protocol + shares.partner, token.decimals),
      result,
      approval,
      ...(device ? { digest: envelopeDigest(message) } : {}),
      ...(proof === undefined ? {} : { delivered_sha256: proof.delivered, announcement: proof.opening.announcement, seq: proof.opening.seq, ...skippedField(proof.skipped) }),
      summary: [
        `Pays: ${paid} of ${name} to ${payTo} from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...(proof === undefined ? [] : [`For: the work with sha256 ${proof.delivered}, announced in ${proof.opening.announcement} (seq ${proof.opening.seq}), the first that opens to it`]),
        ...(proof === undefined ? [] : skippedSummary(proof.skipped)),
        ...(isProof && params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        ...(isProof ? [`Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`] : []),
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(device ? [`Signs: only the release message on the Ledger, which shows digest ${envelopeDigest(message)}; the fee payer ${payer.address} signs and pays the transaction`] : []),
        ...stakeReturned(claimed.stake, claimed.accounts.stakeTo),
        ...leavesBoard(left),
        ...(payee.create.length === 0 ? [] : [`Setup: creates ${payTo}'s ${name} account, paid by ${paidBy}`]),
        ...(treasury.create.length === 0 ? [] : [`Setup: creates the engine treasury's ${name} account for the fee, paid by ${paidBy}`]),
        ...(partner.create.length === 0 ? [] : [`Setup: creates the partner ${held.partner}'s ${name} account for its fee, paid by ${paidBy}`]),
        ...(judge.create.length === 0 ? [] : [`Setup: creates this wallet's ${name} account for the judge fee, paid by ${paidBy}`]),
      ],
      warnings: settlementWarnings(params),
      prepared,
    };
    return sent(ctx, payer, view, input.send, call, {
      preview: device ? `${PREVIEW_APPROVAL_NEXT}; ${DEVICE_RELEASE}` : PREVIEW_APPROVAL_NEXT,
      done: thenSettle(`released to ${payTo}; ${tool("wallet_feedback")} to rate`, left),
    });
  },
});
