import { type Address, type Base64EncodedWireTransaction, type Blockhash, type Instruction, type TransactionSigner } from "@solana/kit";
import { type Config, findAssociatedTokenAddress, type Intent } from "@intent-engine/core";
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
import { bundleSizeFits, badBundleSize, sendBundles, withoutTip } from "./bundle.js";
import { MAX_BUNDLE } from "./jito.js";
import { RateLimited } from "./jupiter.js";
import type { Pricer } from "./market.js";
import { decide, type Plan, standing, type Strategy } from "./plan.js";
import { netShort, solValueFits } from "./net.js";
import { freshly, fromCache } from "./quote-cache.js";
import { spend, type Stock, stockLeft } from "./inventory.js";
import { type Hold, unheld } from "./holds.js";

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
  concurrency?: number;
  planned?(intent: Address): void;
  held?(account: Address): bigint;
  unitPrice(instructions: readonly Instruction[]): Promise<bigint>;
  simulate(wire: Base64EncodedWireTransaction, watch: readonly Address[]): Promise<Simulated>;
  send(wire: Base64EncodedWireTransaction): Promise<Sent>;
  sendBundle?: (wires: readonly Base64EncodedWireTransaction[]) => Promise<string>;
  bundleSize?: number;
};

export type Report = {
  filled: { intent: Address; profit: bigint; cost: bigint; signature: string; rent?: bigint }[];
  sent: { intent: Address; profit: bigint; cost: bigint; signature: string; rent?: bigint; holds?: Hold }[];
  skipped: { intent: Address; reason: string; rent?: bigint }[];
  failed: { intent: Address; error: string }[];
};

export const SIMULATION_REFUSED = "the fill failed in simulation, so it was not sent";

export const BALANCES_REFUSED = "the fill would leave the solver with less of a token than planned, so it was not sent";

export const ROUTE_ACCOUNT_BUDGETS = [40, 30, 20] as const;

export const tooLarge = (bytes: number | null, accounts: number): string =>
  `even the smallest route makes the fill ${bytes === null ? "lock" : `${bytes} bytes with`} ${accounts} accounts; a transaction holds ${PACKET_DATA_SIZE} bytes and ${MAX_TX_ACCOUNTS} accounts`;

export const DEFAULT_CONCURRENCY = 4;

export const MAX_CONCURRENCY = 32;

export const badConcurrency = (value: number): string => `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}, not ${value}`;

export const ALREADY_FILLING = "the order already has a fill in this tick";

export const INVENTORY_SPENT = "the solver no longer holds enough of the output token for this fill";

export function firstToSend(a: Plan, b: Plan): number {
  return Number(b.profit - a.profit) || Number(a.intent.expiresAt - b.intent.expiresAt) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

type Outcome =
  | { kind: "filled" | "sent"; entry: Report["sent"][number] }
  | { kind: "skipped"; entry: Report["skipped"][number] }
  | { kind: "failed"; entry: Report["failed"][number] };

type Ready = {
  plan: Plan;
  context: FillContext;
  tables: Record<Address, Address[]>;
  probe: Base64EncodedWireTransaction;
  latest: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  solverInput: Address;
  solverOutput: Address;
};

type Planned = Outcome | { kind: "ready"; ready: Ready };

type Checked = { kind: "checked"; wire: Base64EncodedWireTransaction; entry: Omit<Report["sent"][number], "signature">; holds?: Hold; spend(): void };

const skipped = (intent: Address, reason: string, rent?: bigint): Outcome => ({
  kind: "skipped",
  entry: { intent, reason, ...(rent === undefined ? {} : { rent }) },
});

const failed = (intent: Address, error: string): Outcome => ({ kind: "failed", entry: { intent, error } });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function planOrder(o: SolverOptions, config: Config, now: bigint, address: Address, intent: Intent): Promise<Planned> {
  const ready = standing(intent, config, now, o.strategy);
  if (typeof ready === "string") {
    return skipped(address, ready);
  }
  const waiting = o.backoff?.waiting(address, intent) ?? null;
  if (waiting !== null) {
    return skipped(address, backingOff(waiting.failures, waiting.seconds));
  }
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
  o.planned?.(address);
  let size: { bytes: number | null; accounts: number } = { bytes: null, accounts: 0 };
  for (const routeAccounts of ROUTE_ACCOUNT_BUDGETS) {
    const budget = { ...o.strategy, routeAccounts };
    const first = await decide(address, intent, config, now, o.pricer, o.solver.address, budget, payable);
    const decision =
      first.kind === "fill" && fromCache(first.plan.route)
        ? await decide(address, intent, config, now, freshly(o.pricer), o.solver.address, budget, payable)
        : first;
    if (decision.kind === "skip") {
      return skipped(address, decision.reason);
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
      return { kind: "ready", ready: { plan, context, tables, probe, latest, solverInput, solverOutput } };
    }
  }
  return skipped(address, tooLarge(size.bytes, size.accounts));
}

async function untipped(o: SolverOptions, ready: Ready): Promise<Planned> {
  if (ready.context.tip === null) {
    return { kind: "ready", ready };
  }
  const bare = await withoutTip(ready.plan, ready.context, o.solver, ready.latest, ready.tables, o.unitPrice);
  return "probe" in bare ? { kind: "ready", ready: { ...ready, ...bare } } : skipped(ready.plan.address, tooLarge(bare.bytes, bare.accounts));
}

async function checkOrder(
  o: SolverOptions,
  caps: { cost: bigint; rent: bigint },
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
): Promise<Outcome | Checked> {
  const { plan, context, tables, probe, latest, solverInput, solverOutput } = ready;
  const address = plan.address;
  const before = await Promise.all([o.chain.tokenAmount(solverInput), o.chain.tokenAmount(solverOutput)]);
  const free = unheld(before[1] ?? 0n, o.held?.(solverOutput) ?? 0n);
  const left = stockLeft(stock, solverOutput, free);
  if (plan.route.inventory === true && left < plan.required) {
    return skipped(address, `${INVENTORY_SPENT}: ${left} left, ${plan.required} needed`);
  }
  const simulated = await o.simulate(probe, [solverInput, solverOutput]);
  if (simulated.err !== null) {
    return failed(address, `${SIMULATION_REFUSED}: ${simulated.err}`);
  }
  const [inputAfter, outputAfter] = simulated.balances;
  const least =
    plan.route.inventory === true
      ? [(before[0] ?? 0n) + plan.fees.net, (before[1] ?? 0n) - plan.required]
      : [before[0] ?? 0n, (before[1] ?? 0n) + plan.profit];
  if (inputAfter === null || inputAfter === undefined || outputAfter === null || outputAfter === undefined || inputAfter < (least[0] ?? 0n) || outputAfter < (least[1] ?? 0n)) {
    return failed(
      address,
      `${BALANCES_REFUSED}: input ${before[0]} to ${inputAfter}, output ${before[1]} to ${outputAfter}, expected at least ${least[0]} and ${least[1]}`,
    );
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
  const kept = rent > 0n ? rent : undefined;
  if (cost > caps.cost) {
    return skipped(address, tooCostly(cost, caps.cost), kept);
  }
  if (rent > caps.rent) {
    return skipped(address, tooMuchRent(rent, caps.rent), kept);
  }
  const short = netShort(plan, o.strategy.minProfit.get(plan.intent.outputMint) ?? 0n, cost, o.strategy.solValue);
  if (short !== null) {
    return skipped(address, short, kept);
  }
  if (wire !== probe) {
    const checked = await o.simulate(wire, [solverInput, solverOutput]);
    if (checked.err !== null) {
      return failed(address, `${SIMULATION_REFUSED}: ${checked.err}`);
    }
  }
  return {
    kind: "checked",
    wire,
    entry: { intent: address, profit: plan.profit, cost, ...(kept === undefined ? {} : { rent: kept }) },
    ...(plan.route.inventory === true ? { holds: { account: solverOutput, amount: plan.required } } : {}),
    spend: () => {
      if (plan.route.inventory === true) {
        spend(stock, solverOutput, free, plan.required);
      }
    },
  };
}

async function fillOrder(
  o: SolverOptions,
  caps: { cost: bigint; rent: bigint },
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
): Promise<Outcome> {
  const checked = await checkOrder(o, caps, mintData, ready, stock);
  if (checked.kind !== "checked") {
    return checked;
  }
  const sent = await o.send(checked.wire);
  checked.spend();
  const holds = !sent.confirmed && checked.holds !== undefined ? { holds: checked.holds } : {};
  return { kind: sent.confirmed ? "filled" : "sent", entry: { ...checked.entry, signature: sent.signature, ...holds } };
}

async function queueOrder(
  o: SolverOptions,
  caps: { cost: bigint; rent: bigint },
  mintData: (mint: Address) => Promise<Uint8Array | null>,
  ready: Ready,
  stock: Stock,
): Promise<Outcome | Checked> {
  const bare = await untipped(o, ready);
  if (bare.kind !== "ready") {
    return bare;
  }
  const checked = await checkOrder(o, caps, mintData, bare.ready, stock);
  if (checked.kind === "checked") {
    checked.spend();
  }
  return checked;
}

export async function tick(o: SolverOptions): Promise<Report> {
  const concurrency = o.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new RangeError(badConcurrency(concurrency));
  }
  const bundleSize = o.bundleSize ?? MAX_BUNDLE;
  if (!bundleSizeFits(bundleSize)) {
    throw new RangeError(badBundleSize(bundleSize));
  }
  const invalid = solValueFits(o.strategy.solValue);
  if (invalid !== null) {
    throw new RangeError(invalid);
  }
  const [config, now, intents] = await Promise.all([o.chain.config(), o.chain.now(), o.chain.intents()]);
  const caps = { cost: o.maxSolCost ?? DEFAULT_MAX_SOL_COST, rent: o.maxRent ?? DEFAULT_MAX_RENT };
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
  const outcomes: (Outcome | undefined)[] = intents.map(() => undefined);
  const readied: ({ index: number; ready: Ready } | undefined)[] = intents.map(() => undefined);
  let limited: string | null = null;
  const work = intents.entries();
  const planner = async (): Promise<void> => {
    while (limited === null) {
      const step = work.next();
      if (step.done === true) {
        return;
      }
      const [index, { address, intent }] = step.value;
      try {
        const result = await planOrder(o, config, now, address, intent);
        if (result.kind === "ready") {
          readied[index] = { index, ready: result.ready };
        } else {
          outcomes[index] = result;
        }
      } catch (error) {
        if (error instanceof RateLimited) {
          limited ??= error.message;
          outcomes[index] = skipped(address, error.message);
        } else {
          outcomes[index] = failed(address, messageOf(error));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, intents.length) }, planner));
  if (limited !== null) {
    for (const [index, { address }] of work) {
      outcomes[index] = skipped(address, limited);
    }
  }
  const planned = readied.filter((entry) => entry !== undefined).sort((a, b) => firstToSend(a.ready.plan, b.ready.plan));
  const filling = new Set<Address>();
  const stock: Stock = new Map();
  const queue: { index: number; ready: Ready; wire: Base64EncodedWireTransaction; entry: Checked["entry"]; holds?: Hold }[] = [];
  let halted: string | null = null;
  for (const { index, ready } of planned) {
    const address = ready.plan.address;
    if (halted !== null) {
      outcomes[index] = skipped(address, halted);
      continue;
    }
    if (filling.has(address)) {
      outcomes[index] = skipped(address, ALREADY_FILLING);
      continue;
    }
    filling.add(address);
    try {
      if (o.sendBundle === undefined) {
        outcomes[index] = await fillOrder(o, caps, mintData, ready, stock);
      } else {
        const checked = await queueOrder(o, caps, mintData, ready, stock);
        if (checked.kind === "checked") {
          queue.push({ index, ready, wire: checked.wire, entry: checked.entry, ...(checked.holds === undefined ? {} : { holds: checked.holds }) });
        } else {
          outcomes[index] = checked;
        }
      }
    } catch (error) {
      if (error instanceof RateLimited) {
        halted = error.message;
        outcomes[index] = skipped(address, halted);
      } else {
        outcomes[index] = failed(address, messageOf(error));
      }
    }
  }
  if (o.sendBundle !== undefined) {
    const last = async (item: (typeof queue)[number]): Promise<Base64EncodedWireTransaction | Outcome> => {
      const { ready, wire } = item;
      if (o.tip === null) {
        return wire;
      }
      try {
        const checked = await checkOrder(o, caps, mintData, ready, new Map());
        if (checked.kind !== "checked") {
          return checked;
        }
        item.entry = checked.entry;
        return checked.wire;
      } catch (error) {
        return error instanceof RateLimited ? skipped(ready.plan.address, error.message) : failed(ready.plan.address, messageOf(error));
      }
    };
    for (const done of await sendBundles(queue, bundleSize, o.sendBundle, last)) {
      outcomes[done.item.index] =
        "refused" in done
          ? done.refused
          : "error" in done
            ? failed(done.item.ready.plan.address, done.error)
            : { kind: "sent", entry: { ...done.item.entry, signature: done.signature, ...(done.item.holds === undefined ? {} : { holds: done.item.holds }) } };
    }
  }
  const report: Report = { filled: [], sent: [], skipped: [], failed: [] };
  for (const outcome of outcomes) {
    if (outcome?.kind === "skipped") {
      report.skipped.push(outcome.entry);
    } else if (outcome?.kind === "failed") {
      report.failed.push(outcome.entry);
    } else if (outcome !== undefined) {
      report[outcome.kind].push(outcome.entry);
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
