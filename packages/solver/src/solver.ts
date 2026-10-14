import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { type Config, findAssociatedTokenAddress, type Intent } from "@intent-engine/core";
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
import { ASSOCIATED_TOKEN_PROGRAM, RateLimited } from "./jupiter.js";
import type { Pricer } from "./market.js";
import { decide, type Plan, standing, type Strategy } from "./plan.js";

export type Chain = {
  config(): Promise<Config>;
  intents(): Promise<{ address: Address; intent: Intent }[]>;
  now(): Promise<bigint>;
  tokenProgram(mint: Address): Promise<Address>;
  exists(address: Address): Promise<boolean>;
  lookupTables(addresses: readonly Address[]): Promise<Record<Address, Address[]>>;
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  tokenAmount(address: Address): Promise<bigint>;
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
  backoff?: Backoff;
  unitPrice(instructions: readonly Instruction[]): Promise<bigint>;
  simulate(wire: Base64EncodedWireTransaction, watch: readonly Address[]): Promise<Simulated>;
  send(wire: Base64EncodedWireTransaction): Promise<Sent>;
};

export type Report = {
  filled: { intent: Address; profit: bigint; signature: string }[];
  sent: { intent: Address; profit: bigint; signature: string }[];
  skipped: { intent: Address; reason: string }[];
  failed: { intent: Address; error: string }[];
};

export const SIMULATION_REFUSED = "the fill failed in simulation, so it was not sent";

export const BALANCES_REFUSED = "the fill would leave the solver with less of a token than planned, so it was not sent";

export const ROUTE_ACCOUNT_BUDGETS = [40, 30, 20] as const;

export const tooLarge = (bytes: number | null, accounts: number): string =>
  `even the smallest route makes the fill ${bytes === null ? "lock" : `${bytes} bytes with`} ${accounts} accounts; a transaction holds ${PACKET_DATA_SIZE} bytes and ${MAX_TX_ACCOUNTS} accounts`;

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

export const DEFAULT_MAX_SOL_COST = 10_000_000n;

export const TOKEN_ACCOUNT_SPACE = 165;

export const TOKEN_2022_ACCOUNT_SPACE = 170;

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

const ACCOUNT_STORAGE_OVERHEAD = 128n;
const LAMPORTS_PER_BYTE_YEAR = 3_480n;
const EXEMPTION_YEARS = 2n;
const ATA_ADDRESS = 1;
const ATA_TOKEN_PROGRAM = 5;

export const rentExempt = (space: number): bigint =>
  (ACCOUNT_STORAGE_OVERHEAD + BigInt(space)) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_YEARS;

export type SolCost = { signatures: number; unitPrice: bigint; computeUnits: number; tip: bigint; rent: bigint };

export function solCost(cost: SolCost): bigint {
  const priority = (cost.unitPrice * BigInt(cost.computeUnits) + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  return LAMPORTS_PER_SIGNATURE * BigInt(cost.signatures) + priority + cost.tip + cost.rent;
}

export const tooCostly = (cost: bigint, cap: bigint): string =>
  `the fill costs ${cost} lamports in fees, tip and rent, more than the cap of ${cap}`;

export function signaturesOf(wire: Base64EncodedWireTransaction): number {
  return Object.keys(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures).length;
}

export async function createdRent(instructions: readonly Instruction[], exists: (address: Address) => Promise<boolean>): Promise<bigint> {
  const opened = new Map<Address, Address>();
  for (const ix of instructions) {
    const account = ix.accounts?.[ATA_ADDRESS]?.address;
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM && account !== undefined && !opened.has(account)) {
      opened.set(account, ix.accounts?.[ATA_TOKEN_PROGRAM]?.address ?? account);
    }
  }
  let rent = 0n;
  for (const [account, program] of opened) {
    if (!(await exists(account))) {
      rent += rentExempt(program === TOKEN_2022_PROGRAM ? TOKEN_2022_ACCOUNT_SPACE : TOKEN_ACCOUNT_SPACE);
    }
  }
  return rent;
}

export const BACKOFF_MAX_PASSES = 32;

export type Backoff = {
  pass(): void;
  waiting(address: Address, intent: Intent): { failures: number; passes: number } | null;
  failed(address: Address, intent: Intent): void;
  succeeded(address: Address): void;
};

const fingerprint = (intent: Intent): string =>
  JSON.stringify(intent, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

export function backoff(): Backoff {
  let current = 0;
  const held = new Map<Address, { print: string; failures: number; until: number }>();
  return {
    pass: () => {
      current += 1;
    },
    waiting: (address, intent) => {
      const entry = held.get(address);
      if (entry === undefined) {
        return null;
      }
      if (entry.print !== fingerprint(intent)) {
        held.delete(address);
        return null;
      }
      const passes = entry.until - current;
      return passes > 0 ? { failures: entry.failures, passes } : null;
    },
    failed: (address, intent) => {
      const print = fingerprint(intent);
      const entry = held.get(address);
      const failures = (entry?.print === print ? entry.failures : 0) + 1;
      const wait = Math.min(2 ** (failures - 1), BACKOFF_MAX_PASSES);
      held.set(address, { print, failures, until: current + wait + 1 });
    },
    succeeded: (address) => {
      held.delete(address);
    },
  };
}

export const backingOff = (failures: number, passes: number): string =>
  `${failures} fill${failures === 1 ? "" : "s"} of this intent failed in a row; it is tried again in ${passes} pass${passes === 1 ? "" : "es"}`;

export async function tick(o: SolverOptions): Promise<Report> {
  const report: Report = { filled: [], sent: [], skipped: [], failed: [] };
  const [config, now, intents] = await Promise.all([o.chain.config(), o.chain.now(), o.chain.intents()]);
  o.backoff?.pass();
  const cap = o.maxSolCost ?? DEFAULT_MAX_SOL_COST;
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
      report.skipped.push({ intent: address, reason: backingOff(waiting.failures, waiting.passes) });
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
        const decision = await decide(address, intent, config, now, o.pricer, o.solver.address, { ...o.strategy, routeAccounts }, payable);
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
      const least = [before[0] ?? 0n, (before[1] ?? 0n) + plan.profit];
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
        rent: await createdRent(instructions, (account) => o.chain.exists(account)),
      });
      if (cost > cap) {
        report.skipped.push({ intent: address, reason: tooCostly(cost, cap) });
        continue;
      }
      const sent = await o.send(wire);
      (sent.confirmed ? report.filled : report.sent).push({ intent: address, profit: plan.profit, signature: sent.signature });
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
    for (const { intent } of [...report.filled, ...report.sent]) {
      o.backoff.succeeded(intent);
    }
  }
  return report;
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
