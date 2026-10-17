import type { Address } from "@solana/kit";
import { findAssociatedTokenAddress, getIntentDecoder, type Intent, IntentStatus } from "@intent-engine/core";
import {
  type Chain,
  cachedPricer,
  type Flight,
  type Pricer,
  type SolverOptions,
  decodeLookupTable,
  firstPricer,
  inventoryPricer,
  landings,
  issuePricer,
  backoff,
  jitoBundles,
  jupiterPricer,
  remembering,
  tick,
  tipAccount,
} from "@intent-engine/solver";
import {
  chainTime,
  createdAccount,
  type Latest,
  loadConfig,
  type ProgramAccount,
  tokenAmountOf,
  tokenProgramOf,
  type Transport,
} from "@intent-engine/client";
import type { Command, IssueSpec } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { priceOf, withPriority } from "./compute.js";
import { QUOTE_TTL } from "./args.js";

const SOLVER_ROUTE_ACCOUNTS = 40;

export const ENV_JUPITER_KEY = "JUPITER_API_KEY";

export const JUPITER_DOMAIN = "jup.ag";

export function jupiterHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === JUPITER_DOMAIN || host.endsWith(`.${JUPITER_DOMAIN}`);
}

export const SOLVER_TABLE_NEXT =
  "put these in an address lookup table you own (solana address-lookup-table create, then extend with them) and pass it to solve with --lookup-table";

export type SolveCommand = Extract<Command, { name: "solve" }>;

export const IN_FLIGHT_SECONDS = 90n;

export const REFRESH_AFTER_SECONDS = 60n;

export function decodedChanges(changed: readonly ProgramAccount[]): { intents: { address: Address; intent: Intent }[]; unreadable: Address[] } {
  const intents: { address: Address; intent: Intent }[] = [];
  const unreadable: Address[] = [];
  for (const { address, data } of changed) {
    try {
      intents.push({ address, intent: getIntentDecoder().decode(data) });
    } catch {
      unreadable.push(address);
    }
  }
  return { intents, unreadable };
}

export async function stillOpen(transport: Transport, intents: readonly Address[]): Promise<Address[]> {
  const views = await transport.getAccounts(intents);
  return intents.filter((_, i) => {
    const view = views[i];
    return view !== null && view !== undefined && getIntentDecoder().decode(view.data).status === IntentStatus.Open;
  });
}

export const watchPricer = (pricer: Pricer, ttlSeconds: number, clock: () => number): Pricer =>
  ttlSeconds === 0 ? pricer : cachedPricer(pricer, { ttlMs: ttlSeconds * 1_000, clock });

export async function watchSolve(command: SolveCommand, interval: number, runtime: Runtime, emit: (value: object) => void): Promise<number> {
  const transport = withPriority(runtime.transport(command.url), command.priority);
  const options = await solverOptions(command, runtime, transport);
  const chain = remembering(options.chain);
  const held = backoff(interval, () => Number(runtime.now()) * 1_000);
  const live: SolverOptions = {
    ...options,
    chain,
    pricer: watchPricer(options.pricer, command.quoteTtl ?? QUOTE_TTL, () => Number(runtime.now()) * 1_000),
    backoff: held,
    send:
      command.jito === undefined ? async (wire) => ({ signature: await transport.submitWire(wire), confirmed: false }) : options.send,
  };
  const failedOnChain = async (signature: string): Promise<boolean> =>
    command.jito === undefined && (await transport.transactionOf?.(signature))?.failed === true;
  const changes = runtime.intentChanges(command.url);
  const inFlight = new Map<Address, Flight>();
  const failing = new Map<Address, bigint>();
  let scannedAt: bigint | null = null;
  let acted = 0;
  try {
    for (let changed: ProgramAccount[] | null = []; changed !== null; changed = await changes.wait(interval)) {
      const now = runtime.now();
      const began = performance.now();
      let full = false;
      try {
        full = changed.length === 0 || scannedAt === null || now - scannedAt >= BigInt(interval);
        const decoded = full ? { intents: await chain.intents(), unreadable: [] } : decodedChanges(changed);
        if (full) {
          scannedAt = now;
          held.retain(decoded.intents, await chain.now());
        }
        if (decoded.unreadable.length > 0) {
          emit({ at: now, scan: "changed", unreadable: decoded.unreadable });
        }
        const listed = decoded.intents;
        const lost = await landings(inFlight, now, listed, failedOnChain, held);
        if (full) {
          for (const [intent, flight] of inFlight) {
            if (flight.until <= now) {
              inFlight.delete(intent);
            }
          }
        }
        const due = listed.filter(({ address }) => !inFlight.has(address));
        const { filled, sent, failed } = await tick({ ...live, chain: { ...chain, intents: async () => due } });
        for (const { intent, signature } of sent) {
          inFlight.set(intent, { until: now + IN_FLIGHT_SECONDS, signature });
        }
        if (filled.length + sent.length + failed.length + lost.length > 0) {
          emit({ at: now, scan: full ? "full" : "changed", ms: Math.round(performance.now() - began), filled, sent, failed: [...lost, ...failed] });
          acted += filled.length + sent.length;
        }
        for (const [intent, at] of failing) {
          if (now - at >= REFRESH_AFTER_SECONDS * 10n) {
            failing.delete(intent);
          }
        }
        const open = await stillOpen(transport, failed.map((f) => f.intent));
        const refresh = open.filter((intent) => {
          const at = failing.get(intent);
          return at === undefined || now - at >= REFRESH_AFTER_SECONDS;
        });
        if (refresh.length > 0) {
          refresh.forEach((intent) => failing.set(intent, now));
          chain.forget();
        }
      } catch (error) {
        chain.forget();
        emit({ at: now, scan: full ? "full" : "changed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    changes.close();
  }
  return acted;
}

export async function solverOptions(command: SolveCommand, runtime: Runtime, transport: Transport): Promise<SolverOptions> {
  const solver = await runtime.loadSigner(command.keypair);
  let latest: Latest | undefined;
  const chain: Chain = {
    config: async () => (await loadConfig(transport)).config,
    intents: async () =>
      (await transport.intents()).map(({ address, data }) => ({ address, intent: getIntentDecoder().decode(data) })),
    now: () => chainTime(transport),
    tokenProgram: (mint) => tokenProgramOf(transport, mint),
    mintData: async (mint) => (await transport.getAccount(mint))?.data ?? null,
    exists: async (address) => (await createdAccount(transport, address)) !== null,
    tokenAmount: async (address) => tokenAmountOf((await transport.getAccount(address))?.data ?? null) ?? 0n,
    lookupTables: async (addresses) => {
      const tables: Record<Address, Address[]> = {};
      for (const address of addresses) {
        const view = await transport.getAccount(address);
        if (view === null) {
          throw new Error(`lookup table ${address} does not exist`);
        }
        tables[address] = decodeLookupTable(view.data);
      }
      return tables;
    },
    blockhash: async () => {
      latest = await transport.latestBlockhash();
      return latest;
    },
  };
  const bundle = command.jito === undefined ? undefined : jitoBundles({ url: command.jito, fetch: runtime.fetch });
  const priced = (routes: readonly IssueSpec[]) =>
    Promise.all(routes.map(async (route) => ({ ...route, outputTokenProgram: await tokenProgramOf(transport, route.outputMint) })));
  const held = async (mint: Address): Promise<bigint> => {
    const token = await findAssociatedTokenAddress({ owner: solver.address, mint, tokenProgram: await tokenProgramOf(transport, mint) });
    return tokenAmountOf((await transport.getAccount(token))?.data ?? null) ?? 0n;
  };
  const stocked = command.inventory ?? [];
  const inventory = stocked.length === 0 ? null : inventoryPricer(await priced(stocked), held);
  const routed: Pricer | null =
    command.jupiter === undefined
      ? command.issue.length === 0
        ? null
        : issuePricer(await priced(command.issue))
      : jupiterPricer({
          baseUrl: command.jupiter,
          fetch: runtime.fetch,
          slippageBps: command.slippageBps,
          maxAccounts: SOLVER_ROUTE_ACCOUNTS,
          ...(runtime.env[ENV_JUPITER_KEY] === undefined || !jupiterHost(command.jupiter)
            ? {}
            : { apiKey: runtime.env[ENV_JUPITER_KEY] }),
          ...(command.routeProgram === undefined ? {} : { swapPrograms: new Set([command.routeProgram]) }),
        });
  return {
    chain,
    pricer: firstPricer(...[inventory, routed].filter((pricer): pricer is Pricer => pricer !== null)),
    solver,
    strategy: { minProfit: command.minProfit, maxFeeBps: command.maxFeeBps },
    concurrency: command.concurrency,
    maxSolCost: command.maxSolCost,
    maxRent: command.maxRent,
    tip: command.tipLamports === 0n ? null : { account: tipAccount(runtime.entropy()), lamports: command.tipLamports },
    lookupTables: command.lookupTables,
    unitPrice: (instructions) => priceOf(transport, command.priority, instructions),
    simulate: async (wire, watch) => {
      const simulated = await transport.simulate(wire, watch);
      return { err: simulated.err, unitsConsumed: simulated.unitsConsumed, balances: simulated.accounts.map(tokenAmountOf) };
    },
    send: async (wire) => {
      if (bundle !== undefined) {
        return { signature: await bundle([wire]), confirmed: false };
      }
      if (latest === undefined) {
        throw new Error("no blockhash was fetched for this transaction");
      }
      return { signature: await transport.sendWire(wire, latest), confirmed: true };
    },
  };
}
