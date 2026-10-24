import { type Address, isAddress } from "@solana/kit";
import {
  buildCreateIntent,
  escrowAmount,
  type FeeConfig,
  feeBpsFor,
  findIntentPda,
  formatAmount,
  type IntentParams,
  InvalidInput,
  Kind,
  MAX_PARTNER_BPS,
  releaseSettles,
  settleBounds,
  nextFreeNonce,
  specMemo,
} from "@intent-engine/core";
import { chainTime, loadUser, mintCapOf, type NonceWindow } from "./accounts.js";
import { escrowCommittee } from "./client-committee.js";
import { NoFreeNonce } from "./client-errors.js";
import {
  type ClientContext,
  type CreateIntentInput,
  DEFAULT_EXPIRES_IN,
  EXPIRES_IN_RANGE,
  MAX_EXPIRES_IN,
  MIN_EXPIRES_IN,
  SPEC_URL_NEEDS_PROOF,
} from "./client-types.js";
import { memoInstruction, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./jobs.js";
import { type Plan, planOf } from "./plan.js";
import { checkWallet } from "./release-plan.js";
import { initUserIfMissing, tokenAccountIfMissing, wrapIfShort } from "./setup.js";

export type CreateIntentPlan = Plan & {
  intent: Address;
  nonce: bigint;
  expiresAt: bigint;
  payTo: Address;
  committee: Address | null;
  registers: boolean;
  createsPayTo: boolean;
  wraps: bigint;
};

export function nonceAfter(owner: Address, user: NonceWindow | null): bigint {
  if (user === null) {
    return 0n;
  }
  const next = nextFreeNonce(user);
  if (next === null) {
    throw new NoFreeNonce(owner);
  }
  return next;
}

export type SettleConfig = FeeConfig & { partnerCutBps: number };

export const PARTNER_BPS_RANGE = `partnerBps must be a whole number from 1 to ${MAX_PARTNER_BPS}`;
export const PARTNER_NEEDS_BPS = "partner needs partnerBps, the partner fee in basis points";
export const BPS_NEEDS_PARTNER = "partnerBps needs partner, the wallet paid the partner fee";
export const PAY_TO_NOT_ATTESTED = "an AttestedResult escrow pays the worker its judge releases to, so it takes no payTo";

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

export type PartnerFee = { key: Address; bps: number };

export function partnerOf(input: Pick<CreateIntentInput, "partner" | "partnerBps">): PartnerFee | undefined {
  const { partner, partnerBps } = input;
  if (partner === undefined && partnerBps === undefined) {
    return undefined;
  }
  if (partnerBps === undefined) {
    throw new InvalidInput("partnerBps", "missing", PARTNER_NEEDS_BPS);
  }
  if (partner === undefined) {
    throw new InvalidInput("partner", "missing", BPS_NEEDS_PARTNER);
  }
  if (!isAddress(partner)) {
    throw new InvalidInput("partner", "format", `partner ${String(partner)} is not a base58 address`);
  }
  if (!Number.isInteger(partnerBps) || partnerBps < 1 || partnerBps > MAX_PARTNER_BPS) {
    throw new InvalidInput("partnerBps", "range", PARTNER_BPS_RANGE);
  }
  return { key: partner, bps: partnerBps };
}

async function payToOf(context: ClientContext, input: CreateIntentInput): Promise<Address> {
  const owner = input.signer.address;
  const { payTo } = input;
  if (payTo === undefined || payTo === owner) {
    return owner;
  }
  if (!isAddress(payTo)) {
    throw new InvalidInput("payTo", "format", `payTo ${String(payTo)} is not a base58 address`);
  }
  if (input.params.kind === Kind.AttestedResult) {
    throw new InvalidInput("payTo", "unsupported", PAY_TO_NOT_ATTESTED);
  }
  await checkWallet(context, payTo);
  return payTo;
}

export async function createIntentPlan(context: ClientContext, input: CreateIntentInput): Promise<CreateIntentPlan> {
  const { transport, mint, config } = context;
  const { signer, params, inputMint, outputMint } = input;
  const owner = signer.address;
  if (input.specUrl !== undefined && (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0))) {
    throw new InvalidInput("specUrl", "conflict", SPEC_URL_NEEDS_PROOF);
  }
  if (input.expiresIn !== undefined && (input.expiresIn < MIN_EXPIRES_IN || input.expiresIn > MAX_EXPIRES_IN)) {
    throw new InvalidInput("expiresIn", "range", EXPIRES_IN_RANGE);
  }
  const partner = partnerOf(input);
  const published = input.specUrl === undefined ? [] : [memoInstruction(signer, specMemo(input.specUrl))];
  if (input.specUrl !== undefined && (await plainHttpOnPublic(transport, input.specUrl))) {
    throw new InvalidInput("specUrl", "format", `the spec url ${input.specUrl} ${PLAIN_HTTP_ON_PUBLIC}`);
  }
  const recipient = await payToOf(context, input);
  const [settings, sell, buy, user, mintCap] = await Promise.all([config(), mint(inputMint), mint(outputMint), loadUser(transport, owner), mintCapOf(transport, inputMint)]);
  const unsettled = neverSettles(params, settings, partner?.bps ?? 0, sell.decimals);
  if (unsettled !== undefined) {
    throw new InvalidInput(partner === undefined ? "params" : "partnerBps", "range", unsettled);
  }
  const judged = await escrowCommittee(transport, settings, inputMint, params);
  const nonce = input.nonce ?? nonceAfter(owner, user);
  const expiresAt = input.expiresAt ?? (await chainTime(transport)) + (input.expiresIn ?? DEFAULT_EXPIRES_IN);
  const receiver = await tokenAccountIfMissing(transport, signer, recipient, outputMint, buy.tokenProgram);
  const wrap = await wrapIfShort(transport, signer, inputMint, sell.tokenProgram, escrowAmount(params));
  const create = await buildCreateIntent({
    owner: signer,
    treasury: settings.feeRecipient,
    maxCreateFee: settings.createFee,
    maxBounty: settings.crankBounty,
    nonce,
    params,
    expiresAt,
    inputMint,
    outputMint,
    inputTokenProgram: sell.tokenProgram,
    outputTokenProgram: buy.tokenProgram,
    ...(partner === undefined ? {} : { partner }),
    ...(recipient === owner ? {} : { receiver: receiver.address, receiverAuthority: recipient }),
    ...(mintCap === undefined ? {} : { mintCap }),
    ...judged,
  });
  const register = await initUserIfMissing(user, signer);
  const [intent] = await findIntentPda({ owner, nonce });
  return {
    ...planOf({ payer: owner, instructions: [...register, ...receiver.create, ...wrap.instructions, create, ...published] }),
    intent,
    nonce,
    expiresAt,
    payTo: recipient,
    committee: judged.committee ?? null,
    registers: register.length > 0,
    createsPayTo: receiver.create.length > 0,
    wraps: wrap.lamports,
  };
}
