import type { Address } from "@solana/kit";
import {
  decodeParamsLoose,
  describeTerms,
  type Intent,
  type IntentParams,
  INTENT_VERSION,
  Kind,
  MAX_PARTNER_BPS,
  NO_MANDATE,
  IntentStatus,
  remainingOf,
} from "@intent-engine/core";
import { STATUS } from "../accounts.js";
import type { Prepared } from "./prepare.js";
import {
  account,
  amount,
  choice,
  type Infer,
  integer,
  list,
  nullable,
  object,
  text,
  time,
  variants,
} from "./schema.js";

export const orderSchema = variants(
  "kind",
  {
    swap: object({
      amount_in: amount("exact raw units of the input token to sell"),
      min_out: amount("least raw units of the output token to receive for the whole amount"),
    }),
    limit: object({
      make_amount: amount("raw units of the input token offered; a fill always takes all of it at once"),
      take_amount: amount("least raw units of the output token wanted for the whole make_amount"),
    }),
    dutch: object({
      amount_in: amount("exact raw units of the input token to sell"),
      start_out: amount("output wanted at start_time; the requirement falls linearly from here"),
      end_out: amount("output wanted from end_time on"),
      start_time: time("unix seconds when the price starts falling"),
      end_time: time("unix seconds when the price stops falling; at or before the expiry"),
    }),
    attested: object({
      amount_in: amount("exact raw units of the input token to sell"),
      min_result: amount("least attested result that settles the intent"),
      max_result: amount("greatest attested result that settles the intent"),
      attestor: account("the key whose signature alone decides the result"),
    }),
  },
  "what to sell and the least to receive",
);

export type Order = Infer<typeof orderSchema>;

export function paramsOf(order: Order): IntentParams {
  switch (order.kind) {
    case "swap":
      return { kind: Kind.SwapExactIn, amountIn: order.amount_in, minOut: order.min_out };
    case "limit":
      return { kind: Kind.LimitOrder, makeAmount: order.make_amount, takeAmount: order.take_amount };
    case "dutch":
      return {
        kind: Kind.DutchAuction,
        amountIn: order.amount_in,
        startOut: order.start_out,
        endOut: order.end_out,
        startTs: order.start_time,
        endTs: order.end_time,
      };
    case "attested":
      return {
        kind: Kind.AttestedResult,
        amountIn: order.amount_in,
        minResult: order.min_result,
        maxResult: order.max_result,
        attestor: order.attestor,
      };
  }
}

export function orderOf(params: IntentParams): Order {
  switch (params.kind) {
    case Kind.SwapExactIn:
      return { kind: "swap", amount_in: params.amountIn, min_out: params.minOut };
    case Kind.LimitOrder:
      return { kind: "limit", make_amount: params.makeAmount, take_amount: params.takeAmount };
    case Kind.DutchAuction:
      return {
        kind: "dutch",
        amount_in: params.amountIn,
        start_out: params.startOut,
        end_out: params.endOut,
        start_time: params.startTs,
        end_time: params.endTs,
      };
    case Kind.AttestedResult:
      return {
        kind: "attested",
        amount_in: params.amountIn,
        min_result: params.minResult,
        max_result: params.maxResult,
        attestor: params.attestor,
      };
  }
}

export const KIND_NAMES = { [Kind.SwapExactIn]: "swap", [Kind.LimitOrder]: "limit", [Kind.DutchAuction]: "dutch", [Kind.AttestedResult]: "attested" } as const;

export const KINDS = [Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult] as const;

export const partnerSchema = object(
  {
    account: account("the integrator paid the partner fee"),
    bps: integer(1, MAX_PARTNER_BPS, "partner fee in basis points of the sold amount"),
  },
  "an integrator fee taken from the sold amount at fill time",
);

export const STATUSES = [...STATUS, "unknown"] as const;

export const intentSchema = object({
  address: account(),
  owner: account(),
  input_mint: account(),
  output_mint: account(),
  receiver: account(),
  nonce: amount(),
  status: choice(STATUSES),
  escrowed: amount("raw input units locked when the intent was created"),
  filled: amount("raw input units already sold"),
  remaining: amount("raw input units still for sale; 0 once the intent is no longer open, its escrow refunded or paid out"),
  created_at: time(),
  expires_at: time(),
  order: nullable(orderSchema),
  partner: nullable(partnerSchema),
  bounty: amount("lamports paid to whoever expires or closes the intent"),
  mandate: nullable(account("the mandate an agent created this under; fills stop once it is revoked")),
  agent_fee: amount("raw input units held for the agent that created it, paid only when it fills"),
  summary: list(text(), 16, "the terms in plain words"),
});

function termsOf(intent: Intent, raw: Uint8Array): IntentParams | string {
  if (intent.version !== INTENT_VERSION) {
    return `unsupported intent version ${intent.version}`;
  }
  const params = decodeParamsLoose(intent.kind, raw);
  return "unknown" in params ? params.reason : params;
}

export type Decimals = { inputDecimals?: number; outputDecimals?: number };

export const SETTLED: ReadonlySet<number> = new Set([IntentStatus.Filled, IntentStatus.Cancelled, IntentStatus.Expired]);

export const SETTLED_LINE =
  "No longer open: its escrow was refunded or paid out, so nothing is locked in it; escrowed only records what was locked at creation";

export function intentView(address: Address, intent: Intent, decimals: Decimals = {}) {
  const raw = Uint8Array.from(intent.params);
  const params = termsOf(intent, raw);
  return {
    address,
    owner: intent.owner,
    input_mint: intent.inputMint,
    output_mint: intent.outputMint,
    receiver: intent.receiver,
    nonce: intent.nonce,
    status: STATUS[intent.status] ?? "unknown",
    escrowed: intent.escrowed,
    filled: intent.filled,
    remaining: intent.status === IntentStatus.Open ? remainingOf(intent) : 0n,
    created_at: intent.createdAt,
    expires_at: intent.expiresAt,
    order: typeof params === "string" ? null : orderOf(params),
    partner: intent.partnerBps === 0 ? null : { account: intent.partner, bps: intent.partnerBps },
    bounty: BigInt(intent.bounty),
    mandate: intent.mandate === NO_MANDATE ? null : intent.mandate,
    agent_fee: intent.agentFee,
    summary: [
      ...(typeof params === "string"
        ? [`Unreadable terms: ${params}`]
        : describeTerms({ kind: params.kind, params: raw, inputMint: intent.inputMint, outputMint: intent.outputMint }, decimals)),
      ...(SETTLED.has(intent.status) ? [SETTLED_LINE] : []),
    ],
  };
}

export const preparedSchema = object(
  {
    transaction: text("base64 wire transaction with empty signature slots; sign it with the wallets in signers"),
    fee_payer: account(),
    signers: list(account(), 4, "every wallet that must sign before sending"),
    last_valid_block_height: amount("send before the cluster passes this block height"),
    units_consumed: nullable(amount("compute units the simulation used")),
    priority_fee_lamports: amount("lamports of priority fee the fee payer pays on top of the network fee"),
    logs: list(text(), 16, "the last simulation log lines"),
  },
  "an unsigned transaction that simulated successfully",
);

export function preparedView(p: Prepared) {
  return {
    transaction: p.transaction,
    fee_payer: p.feePayer,
    signers: p.signers,
    last_valid_block_height: p.lastValidBlockHeight,
    units_consumed: p.unitsConsumed,
    priority_fee_lamports: p.priorityLamports,
    logs: p.logs,
  };
}
