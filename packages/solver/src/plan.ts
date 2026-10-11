import type { Address } from "@solana/kit";
import {
  type Config,
  decodeParamsLoose,
  type FeeShares,
  feeBpsFor,
  type Intent,
  type IntentParams,
  INTENT_VERSION,
  IntentStatus,
  Kind,
  kindBit,
  PAUSE_FILL,
  remainingOf,
  requiredOut,
  splitFees,
} from "@intent-engine/core";
import type { Pricer, Quote } from "./market.js";

export type Cycle = (mint: Address, amount: bigint) => Promise<Quote | null>;

export type Strategy = {
  minProfit: ReadonlyMap<Address, bigint>;
  maxFeeBps: number;
  cycle?: Cycle;
  routeAccounts?: number;
};

export type Payable = (draft: Pick<Plan, "intent" | "fees">) => Promise<string | null>;

export type Plan = {
  address: Address;
  intent: Intent;
  amountIn: bigint;
  required: bigint;
  feeBps: number;
  fees: FeeShares;
  route: Quote;
  arbitrage: Quote | null;
  profit: bigint;
};

export type Decision = { kind: "fill"; plan: Plan } | { kind: "skip"; reason: string };

const skip = (reason: string): Decision => ({ kind: "skip", reason });

export type Standing = { params: IntentParams; floor: bigint; feeBps: number };

export function standing(intent: Intent, config: Config, now: bigint, strategy: Strategy): Standing | string {
  if (intent.version !== INTENT_VERSION) {
    return `unsupported intent version ${intent.version}`;
  }
  if (intent.status !== IntentStatus.Open) {
    return "not open";
  }
  if (now >= intent.expiresAt) {
    return "expired";
  }
  if ((config.paused & PAUSE_FILL) !== 0) {
    return "fills are paused";
  }
  const params = decodeParamsLoose(intent.kind, Uint8Array.from(intent.params));
  if ("unknown" in params) {
    return `unreadable params: ${params.reason}`;
  }
  if ((config.fillDisabledKinds & kindBit(params.kind)) !== 0n) {
    return "fills of this kind are stopped";
  }
  if (params.kind === Kind.AttestedResult) {
    return "settles only with an attestation";
  }
  const floor = strategy.minProfit.get(intent.outputMint);
  if (floor === undefined) {
    return `no profit floor is set for ${intent.outputMint}`;
  }
  const feeBps = feeBpsFor(config, params.kind);
  if (feeBps + intent.partnerBps > strategy.maxFeeBps) {
    return `fees of ${feeBps + intent.partnerBps} bps exceed the bound of ${strategy.maxFeeBps}`;
  }
  return { params, floor, feeBps };
}

export async function decide(
  address: Address,
  intent: Intent,
  config: Config,
  now: bigint,
  pricer: Pricer,
  solver: Address,
  strategy: Strategy,
  payable: Payable = async () => null,
): Promise<Decision> {
  const ready = standing(intent, config, now, strategy);
  if (typeof ready === "string") {
    return skip(ready);
  }
  const { params, floor, feeBps } = ready;
  const amountIn = remainingOf(intent);
  const fees = splitFees(amountIn, feeBps, intent.partnerBps, intent.partnerCutBps);
  const required = requiredOut(params, amountIn, now);
  const unpayable = await payable({ intent, fees });
  if (unpayable !== null) {
    return skip(unpayable);
  }
  const route = await pricer.quote({
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amountIn: fees.net,
    taker: solver,
    ...(strategy.routeAccounts === undefined ? {} : { maxAccounts: strategy.routeAccounts }),
  });
  if (route === null) {
    return skip("no route");
  }
  if (route.amountOut < required) {
    return skip(`the route pays ${route.amountOut}, less than the ${required} the intent requires`);
  }
  const spread = route.amountOut - required;
  const arbitrage = strategy.cycle !== undefined && spread > 0n ? await strategy.cycle(intent.outputMint, spread) : null;
  const gain =
    arbitrage !== null && arbitrage.amountIn <= spread && arbitrage.amountOut > arbitrage.amountIn ? arbitrage : null;
  const profit = gain === null ? spread : spread - gain.amountIn + gain.amountOut;
  if (profit < floor) {
    return skip(`profit ${profit} is below ${floor}`);
  }
  return {
    kind: "fill",
    plan: { address, intent, amountIn, required, feeBps, fees, route, arbitrage: gain, profit },
  };
}
