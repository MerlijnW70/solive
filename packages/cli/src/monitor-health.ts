import type { Address } from "@solana/kit";
import { type Config, DEVNET_TEST_MINT, formatAmount, type Intent, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { readIntentAccounts, U64_MAX } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { CLOCK_SYSVAR, clockTime, loadConfig } from "@intent-engine/client/internal";
import { decide, issuePricer, type Strategy } from "@intent-engine/solver";

export const FILLER_RATE = { out: 200n, in: 1n } as const;
export const FILLER_MIN_PROFIT = 1n;
export const FILLER_MAX_FEE_BPS = 100;
export const LAMPORT_DECIMALS = 9;

export type HealthSpec = { minBalance: ReadonlyMap<Address, bigint>; maxSwapWait: number | null };

export type HealthAlert = { kind: "balance" | "swap-wait"; field: string; expected: unknown; observed: unknown; slot: number } & Record<string, unknown>;

export type HealthFinding = { key: string; mark: string; alert: HealthAlert };

const FILLER_PRICER = issuePricer([
  { inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: FILLER_RATE.out, in: FILLER_RATE.in },
]);

const FILLER_STRATEGY: Strategy = { minProfit: new Map([[DEVNET_TEST_MINT, FILLER_MIN_PROFIT]]), maxFeeBps: FILLER_MAX_FEE_BPS };

export const sol = (lamports: bigint) => `${formatAmount(lamports, LAMPORT_DECIMALS)} SOL`;

export async function fillerFills(address: Address, intent: Intent, config: Config, at: bigint): Promise<boolean> {
  if (intent.inputMint !== NATIVE_MINT || intent.outputMint !== DEVNET_TEST_MINT) {
    return false;
  }
  try {
    const decision = await decide(address, intent, config, at, FILLER_PRICER, intent.owner, FILLER_STRATEGY);
    return decision.kind === "fill" && decision.plan.route.amountOut <= U64_MAX;
  } catch {
    return false;
  }
}

export async function fillableSince(address: Address, intent: Intent, config: Config, now: bigint): Promise<bigint | null> {
  if (!(await fillerFills(address, intent, config, now))) {
    return null;
  }
  let early = intent.createdAt;
  let late = now;
  if (early >= late || (await fillerFills(address, intent, config, early))) {
    return early < late ? early : late;
  }
  while (late - early > 1n) {
    const middle = early + (late - early) / 2n;
    if (await fillerFills(address, intent, config, middle)) {
      late = middle;
    } else {
      early = middle;
    }
  }
  return late;
}

function balanceFindings(spec: HealthSpec, held: readonly bigint[], slot: number): HealthFinding[] {
  return [...spec.minBalance.entries()].flatMap(([wallet, floor], i) => {
    const lamports = held[i] ?? 0n;
    return lamports >= floor
      ? []
      : [{ key: `balance.${wallet}`, mark: "low", alert: { kind: "balance" as const, field: wallet, expected: `at least ${sol(floor)}`, observed: sol(lamports), slot, wallet } }];
  });
}

async function swapFindings(transport: Transport, bound: number, now: bigint, slot: number): Promise<HealthFinding[]> {
  const { config } = await loadConfig(transport);
  const { intents, unreadable } = readIntentAccounts(await transport.intents());
  const found: HealthFinding[] = unreadable.map(({ address, reason }) => ({
    key: `swapWait.${address}`,
    mark: "unreadable",
    alert: { kind: "swap-wait", field: "intent", expected: "a readable intent", observed: reason, slot, intent: address },
  }));
  for (const { address, intent } of intents) {
    const since = await fillableSince(address, intent, config, now);
    if (since === null || now - since <= BigInt(bound)) {
      continue;
    }
    const waited = Number(now - since);
    found.push({
      key: `swapWait.${address}`,
      mark: "waiting",
      alert: { kind: "swap-wait", field: "waited", expected: `filled within ${bound} seconds`, observed: `${waited} seconds`, slot, intent: address, waited },
    });
  }
  return found;
}

export async function healthFindings(transport: Transport, spec: HealthSpec, slot: bigint): Promise<HealthFinding[]> {
  if (spec.minBalance.size === 0 && spec.maxSwapWait === null) {
    return [];
  }
  const [clock, ...wallets] = await transport.getAccounts([CLOCK_SYSVAR, ...spec.minBalance.keys()]);
  const at = Number(slot);
  const held = wallets.map((view) => view?.lamports ?? 0n);
  return [
    ...balanceFindings(spec, held, at),
    ...(spec.maxSwapWait === null ? [] : await swapFindings(transport, spec.maxSwapWait, clockTime(clock ?? null), at)),
  ];
}
