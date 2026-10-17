import { type Address, type Base64EncodedWireTransaction, type Blockhash, type Instruction, type TransactionSigner } from "@solana/kit";
import { type Config, findAssociatedTokenAddress, type Intent, IntentStatus } from "@intent-engine/core";
import { type Backoff, backingOff } from "./backoff.js";
import { createdRent, DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST, signaturesOf, solCost, tooCostly, tooMuchRent } from "./costs.js";
import {
  accountsOf,
  bytesFit,
  compile,
  type FillContext,
  fillInstructions,
  headroom,
  locksFit,
  lookupTablesOf,
  MAX_COMPUTE_UNITS,
  MAX_TX_ACCOUNTS,
  PACKET_DATA_SIZE,
  payoutAccounts,
  type Tip,
  wireSize,
} from "./build.js";
import { RateLimited } from "./jupiter.js";
import type { Pricer } from "./market.js";
import { decide, type Plan, standing, type Strategy } from "./plan.js";
import { fromCache } from "./quote-cache.js";

export { BACKOFF_MAX_INTERVALS, type Backoff, backingOff, backoff } from "./backoff.js";
export {
  createdRent,
  DEFAULT_MAX_RENT,
  DEFAULT_MAX_SOL_COST,
  LAMPORTS_PER_SIGNATURE,
  MICRO_LAMPORTS_PER_LAMPORT,
  mintExtensions,
  rentExempt,
  type SolCost,
  signaturesOf,
  solCost,
  TOKEN_2022_ACCOUNT_SPACE,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SPACE,
  tokenAccountSpace,
  tooCostly,
  tooMuchRent,
} from "./costs.js";

export type Chain = {
  config(): Promise<Config>;
  intents(): Promise<{ address: Address; intent: Intent }[]>;
  now(): Promise<bigint>;
  tokenProgram(mint: Address): Promise<Address>;
  exists(address: Address): Promise<boolean>;
  lookupTables(addresses: readonly Address[]): Promise<Record<Address, Address[]>>;
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  tokenAmount(address: Address): Promise<bigint>;
  mintData?(mint: Address): Promise<Uint8Array | null>;
};

export type Simulated = { err: string | null; unitsConsumed: bigint | null; balances: readonly (bigint | null)[] };

export type Sent = { signature: string; confirmed: boolean };

export type SolverOptions = {
  chain: Chain;
  pricer: Pricer;
  solver: TransactionSigner;
  strategy: Strategy;
  tip: Tip | null;
  lookupTables?: readonly Address[];
  maxSolCost?: bigint;
  maxRent?: bigint;
  backoff?: Backoff;
  unitPrice(instructions: readonly Instruction[]): Promise<bigint>;
  simulate(wire: Base64EncodedWireTransaction, watch: readonly Address[]): Promise<Simulated>;
  send(wire: Base64EncodedWireTransaction): Promise<Sent>;
};

export type Report = {
  filled: { intent: Address; profit: bigint; signature: string; rent?: bigint }[];
  sent: { intent: Address; profit: bigint; signature: string; rent?: bigint }[];
  skipped: { intent: Address; reason: string; rent?: bigint }[];
  failed: { intent: Address; error: string }[];
};

export const SIMULATION_REFUSED = "the fill failed in simulation, so it was not sent";

export const BALANCES_REFUSED = "the fill would leave the solver with less of a token than planned, so it was not sent";

export const ROUTE_ACCOUNT_BUDGETS = [40, 30, 20] as const;

export const tooLarge = (bytes: number | null, accounts: number): string =>
  `even the smallest route makes the fill ${bytes === null ? "lock" : `${bytes} bytes with`} ${accounts} accounts; a transaction holds ${PACKET_DATA_SIZE} bytes and ${MAX_TX_ACCOUNTS} accounts`;

export async function tick(o: SolverOptions): Promise<Report> {
  const report: Report = { filled: [], sent: [], skipped: [], failed: [] };
  const [config, now, intents] = await Promise.all([o.chain.config(), o.chain.now(), o.chain.intents()]);
  const cap = o.maxSolCost ?? DEFAULT_MAX_SOL_COST;
  const rentCap = o.maxRent ?? DEFAULT_MAX_RENT;
  const mints = new Map<Address, Promise<Uint8Array | null>>();
  const mintData = (mint: Address): Promise<Uint8Array | null> => {
    const known = mints.get(mint);
    if (known !== undefined) {
      return known;
    }
    const loaded = o.chain.mintData?.(mint) ?? Promise.resolve(null);
    mints.set(mint, loaded);
    return loaded;
  };
  const freshly: Pricer = { quote: (request) => o.pricer.quote({ ...request, fresh: true }) };
  let limited: string | null = null;
  for (const { address, intent } of intents) {
    if (limited !== null) {
      report.skipped.push({ intent: address, reason: limited });
      continue;
    }
    const ready = standing(intent, config, now, o.strategy);
    if (typeof ready === "string") {
      report.skipped.push({ intent: address, reason: ready });
      continue;
    }
    const waiting = o.backoff?.waiting(address, intent) ?? null;
    if (waiting !== null) {
      report.skipped.push({ intent: address, reason: backingOff(waiting.failures, waiting.seconds) });
      continue;
    }
    try {
      const [inputTokenProgram, outputTokenProgram] = await Promise.all([
        o.chain.tokenProgram(intent.inputMint),
        o.chain.tokenProgram(intent.outputMint),
      ]);
      const payable = async (draft: Parameters<typeof payoutAccounts>[0]) => {
        const payouts = await payoutAccounts(draft, config.feeRecipient, inputTokenProgram);
        const found = await Promise.all(payouts.map((payout) => o.chain.exists(payout.address)));
        const missing = payouts.filter((_, i) => !found[i]).map((payout) => payout.name);
        return missing.length === 0 ? null : `no ${missing.join(" or ")} account to pay into`;
      };
      const solverInput = await findAssociatedTokenAddress({
        owner: o.solver.address,
        mint: intent.inputMint,
        tokenProgram: inputTokenProgram,
      });
      const solverOutput = await findAssociatedTokenAddress({
        owner: o.solver.address,
        mint: intent.outputMint,
        tokenProgram: outputTokenProgram,
      });
      const [inputExists, outputExists, latest] = await Promise.all([
        o.chain.exists(solverInput),
        o.chain.exists(solverOutput),
        o.chain.blockhash(),
      ]);
      const draft: FillContext = {
        solver: o.solver,
        feeRecipient: config.feeRecipient,
        inputTokenProgram,
        outputTokenProgram,
        computeUnits: MAX_COMPUTE_UNITS,
        unitPrice: 0n,
        createSolverInput: !inputExists,
        createSolverOutput: !outputExists,
        tip: o.tip,
      };
      let fitting: { plan: Plan; context: FillContext; tables: Record<Address, Address[]>; probe: Base64EncodedWireTransaction } | null =
        null;
      let skipped: string | null = null;
      let size: { bytes: number | null; accounts: number } = { bytes: null, accounts: 0 };
      for (const routeAccounts of ROUTE_ACCOUNT_BUDGETS) {
        const budget = { ...o.strategy, routeAccounts };
        const first = await decide(address, intent, config, now, o.pricer, o.solver.address, budget, payable);
        const decision =
          first.kind === "fill" && fromCache(first.plan.route)
            ? await decide(address, intent, config, now, freshly, o.solver.address, budget, payable)
            : first;
        if (decision.kind === "skip") {
          skipped = decision.reason;
          break;
        }
        const plan = decision.plan;
        const context = { ...draft, unitPrice: await o.unitPrice(await fillInstructions(plan, draft)) };
        const instructions = await fillInstructions(plan, context);
        const accounts = accountsOf(instructions, o.solver.address);
        if (!locksFit(accounts)) {
          size = { bytes: null, accounts };
          continue;
        }
        const tables = await o.chain.lookupTables(lookupTablesOf(plan, o.lookupTables));
        const probe = await compile(instructions, o.solver, latest, tables);
        const bytes = wireSize(probe);
        size = { bytes, accounts };
        if (bytesFit(bytes)) {
          fitting = { plan, context, tables, probe };
          break;
        }
      }
      if (skipped !== null || fitting === null) {
        report.skipped.push({ intent: address, reason: skipped ?? tooLarge(size.bytes, size.accounts) });
        continue;
      }
      const { plan, context, tables, probe } = fitting;
      const before = await Promise.all([o.chain.tokenAmount(solverInput), o.chain.tokenAmount(solverOutput)]);
      const simulated = await o.simulate(probe, [solverInput, solverOutput]);
      if (simulated.err !== null) {
        report.failed.push({ intent: address, error: `${SIMULATION_REFUSED}: ${simulated.err}` });
        continue;
      }
      const [inputAfter, outputAfter] = simulated.balances;
      const least =
        plan.route.inventory === true
          ? [(before[0] ?? 0n) + plan.fees.net, (before[1] ?? 0n) - plan.required]
          : [before[0] ?? 0n, (before[1] ?? 0n) + plan.profit];
      if (inputAfter === null || inputAfter === undefined || outputAfter === null || outputAfter === undefined || inputAfter < (least[0] ?? 0n) || outputAfter < (least[1] ?? 0n)) {
        report.failed.push({
          intent: address,
          error: `${BALANCES_REFUSED}: input ${before[0]} to ${inputAfter}, output ${before[1]} to ${outputAfter}, expected at least ${least[0]} and ${least[1]}`,
        });
        continue;
      }
      const final = simulated.unitsConsumed === null ? context : { ...context, computeUnits: headroom(simulated.unitsConsumed) };
      const instructions = await fillInstructions(plan, final);
      const wire = simulated.unitsConsumed === null ? probe : await compile(instructions, o.solver, latest, tables);
      const cost = solCost({
        signatures: signaturesOf(wire),
        unitPrice: final.unitPrice,
        computeUnits: final.computeUnits,
        tip: final.tip?.lamports ?? 0n,
      });
      const rent = await createdRent(instructions, (account) => o.chain.exists(account), mintData);
      const kept = rent > 0n ? { rent } : {};
      if (cost > cap) {
        report.skipped.push({ intent: address, reason: tooCostly(cost, cap), ...kept });
        continue;
      }
      if (rent > rentCap) {
        report.skipped.push({ intent: address, reason: tooMuchRent(rent, rentCap), ...kept });
        continue;
      }
      if (wire !== probe) {
        const checked = await o.simulate(wire, [solverInput, solverOutput]);
        if (checked.err !== null) {
          report.failed.push({ intent: address, error: `${SIMULATION_REFUSED}: ${checked.err}` });
          continue;
        }
      }
      const sent = await o.send(wire);
      (sent.confirmed ? report.filled : report.sent).push({ intent: address, profit: plan.profit, signature: sent.signature, ...kept });
    } catch (error) {
      if (error instanceof RateLimited) {
        limited = error.message;
        report.skipped.push({ intent: address, reason: limited });
        continue;
      }
      report.failed.push({ intent: address, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (o.backoff !== undefined) {
    const known = new Map(intents.map(({ address, intent }) => [address, intent]));
    for (const { intent } of report.failed) {
      const state = known.get(intent);
      if (state !== undefined) {
        o.backoff.failed(intent, state);
      }
    }
    for (const { intent } of report.filled) {
      o.backoff.succeeded(intent);
    }
  }
  return report;
}

export type Flight = { until: bigint; signature: string };

export const FAILED_ON_CHAIN = "the fill was sent but failed on chain";

export async function landings(
  flights: Map<Address, Flight>,
  now: bigint,
  listed: readonly { address: Address; intent: Intent }[],
  failedOnChain: (signature: string) => Promise<boolean>,
  held: Backoff,
): Promise<{ intent: Address; error: string }[]> {
  const failed: { intent: Address; error: string }[] = [];
  for (const { address, intent } of listed) {
    const flight = flights.get(address);
    if (flight === undefined || flight.until > now) {
      continue;
    }
    flights.delete(address);
    if (intent.status !== IntentStatus.Open) {
      continue;
    }
    const lost = await failedOnChain(flight.signature).catch(() => false);
    if (lost) {
      held.failed(address, intent);
      failed.push({ intent: address, error: `${FAILED_ON_CHAIN}: ${flight.signature}` });
    }
  }
  return failed;
}

export const CONFIG_TTL_MS = 30_000;

export const BLOCKHASH_TTL_MS = 20_000;

export type Remembering = Chain & { forget(): void };

function fresh<T>(ttl: number, clock: () => number, load: () => Promise<T>): { get(): Promise<T>; clear(): void } {
  let held: { at: number; value: Promise<T> } | null = null;
  return {
    get: () => {
      if (held === null || clock() - held.at > ttl) {
        const value = load();
        const entry = { at: clock(), value };
        held = entry;
        value.catch(() => {
          if (held === entry) {
            held = null;
          }
        });
      }
      return held.value;
    },
    clear: () => {
      held = null;
    },
  };
}

export function remembering(chain: Chain, clock: () => number = Date.now): Remembering {
  const programs = new Map<Address, Promise<Address>>();
  const mints = new Map<Address, Promise<Uint8Array | null>>();
  const existing = new Set<Address>();
  const config = fresh(CONFIG_TTL_MS, clock, () => chain.config());
  const blockhash = fresh(BLOCKHASH_TTL_MS, clock, () => chain.blockhash());
  return {
    ...chain,
    config: () => config.get(),
    blockhash: () => blockhash.get(),
    tokenProgram: (mint) => {
      const known = programs.get(mint);
      if (known !== undefined) {
        return known;
      }
      const loaded = chain.tokenProgram(mint);
      programs.set(mint, loaded);
      loaded.catch(() => programs.delete(mint));
      return loaded;
    },
    ...(chain.mintData === undefined
      ? {}
      : {
          mintData: (mint: Address) => {
            const known = mints.get(mint);
            if (known !== undefined) {
              return known;
            }
            const loaded = chain.mintData?.(mint) ?? Promise.resolve(null);
            mints.set(mint, loaded);
            loaded.then(
              (data) => {
                if (data === null) {
                  mints.delete(mint);
                }
              },
              () => mints.delete(mint),
            );
            return loaded;
          },
        }),
    exists: async (address) => {
      if (existing.has(address)) {
        return true;
      }
      const found = await chain.exists(address);
      if (found) {
        existing.add(address);
      }
      return found;
    },
    forget: () => {
      programs.clear();
      existing.clear();
      config.clear();
      blockhash.clear();
    },
  };
}
