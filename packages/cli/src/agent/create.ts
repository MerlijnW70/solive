import { type Address, createNoopSigner, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  buildCreateIntent,
  committeeFloorOf,
  computeUnitLimit,
  computeUnitPrice,
  type Config,
  FLOOR_THRESHOLD,
  describeTerms,
  encodeParams,
  escrowAmount,
  feeBpsFor,
  type FeeConfig,
  formatAmount,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  type IntentParams,
  isMemoUrl,
  Kind,
  MEMO_URL_RULE,
  specMemo,
  LONG_LIVED_SECONDS,
  MAX_COMPUTE_UNITS,
  NATIVE_MINT,
  partnerBaseOf,
  partnerFeeLine,
  releaseSettles,
  settleBounds,
  validate,
  settlementWarnings,
  WARN_LONG_LIVED,
  WARN_RECEIVER,
} from "@intent-engine/core";
import {
  chainTime,
  CLOCK_SYSVAR,
  escrowCommittee,
  initUserIfMissing,
  isSdkError,
  loadConfig,
  loadUser,
  memoInstruction,
  mintCapOf,
  mintOf,
  PLAIN_HTTP_ON_PUBLIC,
  plainHttpOnPublic,
  keylessJudges,
  tokenAccountIfMissing,
  type Transport,
  noJudgeKey,
  PACKET_DATA_SIZE,
  wrapIfShort,
} from "@intent-engine/client";
import { expiresLine } from "./expiry.js";
import { type AgentContext, define } from "./actions.js";
import { tool } from "./names.js";
import { type Call, claim, claimedBy, PREPARED_TTL } from "./claims.js";
import { pickNonce, setupLines, unusedIntent, walletRecipient } from "./owner.js";
import { prepare, transactionSize } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import { InvalidInput } from "./schema.js";
import { orderSchema, paramsOf, partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, list, object, optional, type Schema, text, time } from "./schema.js";

export const SPEC_URL_PLAIN = `${PLAIN_HTTP_ON_PUBLIC}; give an https url`;

export const WRAPPED = ", as wrapped SOL they unwrap themselves";

export const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
export const MIN_EXPIRES_IN = 60;

export function expiryOf(input: { expires_at?: bigint; expires_in?: number }, now: bigint): bigint {
  if (input.expires_at !== undefined && input.expires_in === undefined) {
    return input.expires_at;
  }
  if (input.expires_in !== undefined && input.expires_at === undefined) {
    return now + BigInt(input.expires_in);
  }
  throw new InvalidInput([{ path: "expires_at", message: "give exactly one of expires_at or expires_in" }]);
}

export const termsInput = {
  owner: account("the wallet that sells and signs; it pays the fees and rent"),
  input_mint: account("the token to sell"),
  output_mint: account("the token to receive"),
  order: orderSchema,
  expires_at: optional(time("unix seconds after which nobody can fill the intent; give exactly one of expires_at and expires_in")),
  expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "seconds from now until the intent expires; give exactly one of expires_at and expires_in")),
  nonce: optional(amount("leave out to use the owner's next free nonce")),
  partner: optional(partnerSchema),
};

export const termsOutput = {
  intent: account("the address the intent will have"),
  nonce: amount(),
  expires_at: time(),
  escrow: amount("raw input units locked until the intent is filled, cancelled or expired"),
  summary: list(text(), 24, "the terms in plain words; show these to the owner before signing"),
  warnings: list(text(), 16),
};

export const WARN_SCALED =
  "a token here scales the amounts wallets display (interest-bearing or scaled UI amount); the amounts shown are base units at its decimals";

export function warningsOf(params: IntentParams, expiresAt: bigint, now: bigint, scaled: boolean): string[] {
  return [
    ...settlementWarnings(params),
    ...(expiresAt - now > LONG_LIVED_SECONDS ? [WARN_LONG_LIVED] : []),
    ...(scaled ? [WARN_SCALED] : []),
  ];
}

export type SettleConfig = FeeConfig & { partnerCutBps: number };

export function neverSettles(params: IntentParams, config: SettleConfig, partnerBps: number, decimals: number): string | undefined {
  if (params.kind !== Kind.AttestedResult) {
    return undefined;
  }
  const terms = { amount: params.amountIn, judgeFee: params.judgeFee, feeBps: feeBpsFor(config, Kind.AttestedResult), partnerBps, cutBps: config.partnerCutBps };
  if (releaseSettles(terms)) {
    return undefined;
  }
  const shown = (raw: bigint) => formatAmount(raw, decimals);
  const left = terms.amount <= terms.judgeFee ? 0n : terms.amount - terms.judgeFee;
  const { leastAmount, mostJudgeFee } = settleBounds(terms);
  const fixes = [
    ...(leastAmount === undefined ? [] : [`escrow at least ${shown(leastAmount)}`]),
    ...(mostJudgeFee === undefined || terms.judgeFee === 0n ? [] : [`lower the judge fee to at most ${shown(mostJudgeFee)}`]),
  ];
  return `no release of this escrow could settle: ${shown(terms.amount)} less the ${shown(terms.judgeFee)} judge fee leaves ${shown(left)}, too little for the rounded-up ${terms.feeBps} bps protocol fee and ${partnerBps} bps partner fee; ${fixes.length === 0 ? "no amount settles under today's config" : fixes.join(", or ")}`;
}

type Floors = Pick<Config, "floorMints" | "floorAmounts">;

export const committeeNeeded = (escrow: string, floor: string, attestor: Address) =>
  `this escrow of ${escrow} reaches its token's committee floor of ${floor}, so its attestor must be a committee of at least ${FLOOR_THRESHOLD} judges; ${attestor} is not. Name such a committee, or escrow less`;

export function floorLines(config: Floors, mint: Address, decimals: number): string[] {
  const floor = committeeFloorOf(config, mint);
  return floor === 0n ? [] : [`Committee floor: escrows of ${formatAmount(floor, decimals)} or more of this token need a committee of at least ${FLOOR_THRESHOLD} judges as attestor`];
}

export async function escrowJudge(transport: Transport, config: Floors, mint: Address, params: IntentParams, decimals: number): Promise<{ committee?: Address }> {
  try {
    return await escrowCommittee(transport, config, mint, params);
  } catch (error) {
    if (isSdkError(error, "committee-needed")) {
      throw new AgentRefusal("CommitteeRequired", committeeNeeded(formatAmount(error.escrow, decimals), formatAmount(error.floor, decimals), error.attestor));
    }
    throw error;
  }
}

const createInput = object({
  ...termsInput,
  pay_to: optional(account("the wallet that receives what the solver pays; default the owner")),
  spec_url: optional(text(`where the acceptance spec of an attested order with spec_hash is published, ${MEMO_URL_RULE}; recorded in a memo the owner signs with the create, so workers find it`)),
});

type CreateInput = typeof createInput extends Schema<infer T> ? T : never;

export type AfterCreate = (owner: TransactionSigner, intent: Address) => Promise<Instruction[]>;

export const claimsTooLarge = (size: number): string =>
  `the escrow and the claims it opens build a ${size}-byte transaction, over the ${PACKET_DATA_SIZE}-byte limit, and a Ledger signs only the one transaction it previewed; nothing was sent; seal the spec to fewer workers, or escrow without claim_stake and claim_secs and open claims with intent-engine claims open --workers, which sends a long list in parts`;

async function checkFits(transport: Transport, instructions: readonly Instruction[], payer: Address): Promise<void> {
  const size = await transactionSize(transport, [...instructions, computeUnitLimit(MAX_COMPUTE_UNITS), computeUnitPrice(1n)], payer);
  if (size > PACKET_DATA_SIZE) {
    throw new AgentRefusal("ClaimListTooLarge", claimsTooLarge(size));
  }
}

export const prepareCreate = define({
  name: tool("prepare_create"),
  title: "Prepare a new intent",
  description:
    "Build the transaction that escrows the owner's tokens in a new intent: sell exactly the given amount and receive at least the given output before the expiry (for attested orders, an amount set by the attested result), or get everything back. Returns an unsigned transaction that already simulated successfully; the owner's wallet must sign and send it. Nothing moves until then.",
  effect: "prepare",
  input: createInput,
  output: object({
    ...termsOutput,
    create_fee: amount("lamports the owner pays the treasury"),
    crank_bounty: amount("lamports the owner escrows for whoever later expires or closes the intent"),
    wraps: amount("lamports of the owner's SOL wrapped first so the escrow can be drawn from their wrapped SOL account; 0 for other tokens"),
    prepared: preparedSchema,
  }),
  run: (ctx, input, call) => createIntent(ctx, input, call),
});

export async function createIntent({ transport, claims }: AgentContext, input: CreateInput, call: Call, after?: AfterCreate) {
  const [[configAddress], [userAddress]] = await Promise.all([findConfigPda(), findUserStatePda({ owner: input.owner })]);
  await transport.warm?.([CLOCK_SYSVAR, configAddress, input.input_mint, input.output_mint, userAddress]);
  const now = await chainTime(transport);
  const expiresAt = expiryOf(input, now);
  const order = paramsOf(input.order);
  const specUrl = input.spec_url;
  if (specUrl !== undefined && (order.kind !== Kind.AttestedResult || order.specHash.every((b) => b === 0))) {
    throw new InvalidInput([{ path: "spec_url", message: "needs an attested order with spec_hash" }]);
  }
  if (specUrl !== undefined && !isMemoUrl(specUrl)) {
    throw new InvalidInput([{ path: "spec_url", message: `must be ${MEMO_URL_RULE}` }]);
  }
  if (specUrl !== undefined && (await plainHttpOnPublic(transport, specUrl))) {
    throw new InvalidInput([{ path: "spec_url", message: SPEC_URL_PLAIN }]);
  }
  const { config } = await loadConfig(transport);
  const [inputToken, outputToken] = [await mintOf(transport, input.input_mint), await mintOf(transport, input.output_mint)];
  const unsettled = neverSettles(order, config, input.partner?.bps ?? 0, inputToken.decimals);
  if (unsettled !== undefined) {
    throw new AgentRefusal("NeverSettles", unsettled);
  }
  const params = validate(order);
  const judged = await escrowJudge(transport, config, input.input_mint, params, inputToken.decimals);
  const user = await loadUser(transport, input.owner);
  if (input.nonce !== undefined) {
    await unusedIntent(transport, input.owner, input.nonce);
  }
  const nonce = pickNonce(user, input.nonce, claimedBy(claims, input.owner, now));
  claim(claims, call, input.owner, nonce, now + PREPARED_TTL, now);
  const recipient = input.pay_to ?? input.owner;
  if (recipient !== input.owner) {
    await walletRecipient(transport, recipient, "pay_to");
  }
  const [[intentAddress], receiverAddress, sourceAddress] = await Promise.all([
    findIntentPda({ owner: input.owner, nonce }),
    findAssociatedTokenAddress({ owner: recipient, mint: input.output_mint, tokenProgram: outputToken.tokenProgram }),
    findAssociatedTokenAddress({ owner: input.owner, mint: input.input_mint, tokenProgram: inputToken.tokenProgram }),
  ]);
  await transport.warm?.([intentAddress, receiverAddress, sourceAddress]);
  const intent = await unusedIntent(transport, input.owner, nonce);
  const owner = createNoopSigner(input.owner);
  const receiver = await tokenAccountIfMissing(transport, owner, recipient, input.output_mint, outputToken.tokenProgram);
  const elsewhere = recipient !== input.owner;
  const mintCap = await mintCapOf(transport, input.input_mint);
  const create = await buildCreateIntent({
    owner,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce,
    params,
    expiresAt,
    ...(input.partner === undefined ? {} : { partner: { key: input.partner.account, bps: input.partner.bps } }),
    inputMint: input.input_mint,
    outputMint: input.output_mint,
    inputTokenProgram: inputToken.tokenProgram,
    outputTokenProgram: outputToken.tokenProgram,
    ...(elsewhere ? { receiver: receiver.address, receiverAuthority: recipient } : {}),
    ...(mintCap === undefined ? {} : { mintCap }),
    ...judged,
  });
  const register = await initUserIfMissing(user, input.owner);
  const wrap = await wrapIfShort(transport, input.owner, input.input_mint, inputToken.tokenProgram, escrowAmount(params));
  const published = specUrl === undefined ? [] : [memoInstruction(owner, specMemo(specUrl))];
  const opened = after === undefined ? [] : await after(owner, intent);
  const instructions = [...register, ...receiver.create, ...wrap.instructions, create, ...published, ...opened];
  if (opened.length > 0) {
    await checkFits(transport, instructions, input.owner);
  }
  const prepared = await prepare(transport, instructions, input.owner);
  const keyless = params.kind === Kind.AttestedResult && params.specHash.some((b) => b !== 0) ? await keylessJudges(transport, params.attestor) : [];
  return {
    intent,
    nonce,
    expires_at: expiresAt,
    escrow: escrowAmount(params),
    summary: [
      ...describeTerms(
        { kind: params.kind, params: encodeParams(params), inputMint: input.input_mint, outputMint: input.output_mint },
        { inputDecimals: inputToken.decimals, outputDecimals: outputToken.decimals, ...tokenNames(input.input_mint, input.output_mint) },
      ),
      expiresLine(expiresAt, now),
      ...(params.kind === Kind.AttestedResult ? floorLines(config, input.input_mint, inputToken.decimals) : []),
      ...(judged.committee === undefined ? [] : [`Judged by: the committee ${judged.committee}, passed with the create`]),
      ...(specUrl === undefined ? [] : [`Publishes: the acceptance spec's url ${specUrl}, in a memo the owner signs`]),
      ...(elsewhere ? [`Pays to: ${recipient}, who receives what the solver pays${input.output_mint === NATIVE_MINT ? WRAPPED : ""}`] : []),
      ...(input.partner === undefined ? [] : [partnerFeeLine(input.partner.bps, input.partner.account, partnerBaseOf(params))]),
      ...setupLines({
        registers: register.length > 0,
        creates: receiver.create.length > 0 && !elsewhere ? [input.output_mint] : [],
        allowance: null,
        wraps: wrap.lamports,
      }).lines,
      ...(receiver.create.length > 0 && elsewhere ? [`Setup: creates ${recipient}'s token account for ${input.output_mint} (you pay its rent)`] : []),
    ],
    warnings: [
      ...warningsOf(params, expiresAt, now, inputToken.scaled || outputToken.scaled),
      ...(elsewhere ? [WARN_RECEIVER] : []),
      ...keyless.map(noJudgeKey),
    ],
    create_fee: BigInt(config.createFee),
    crank_bounty: BigInt(config.crankBounty),
    wraps: wrap.lamports,
    prepared: preparedView(prepared),
  };
}
