import type { Address } from "@solana/kit";
import type { ListedSignature } from "@intent-engine/client";
import { NATIVE_MINT } from "@intent-engine/core";
import { activitiesOf } from "./activity.js";
import { applyOpenJobs, applyTransactions, pruned } from "./apply.js";
import type { FeedConfig } from "./env.js";
import { CLUSTER, type Limits, SOL_DECIMALS } from "./limits.js";
import type { Reader } from "./reader.js";
import { raced, RateLimited, ReadFailed, ReadTimedOut } from "./rpc.js";
import { render } from "./render.js";
import { type Probe, servicesOf } from "./services.js";
import type { Feed, Pending, State } from "./shapes.js";
import type { StateStore } from "./store.js";

export type FeedDeps = {
  readonly config: FeedConfig;
  readonly store: StateStore;
  readonly connect: (deadline: AbortSignal) => Reader;
  readonly probe: Probe;
  readonly limits: Limits;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

const listedOf = ({ signature, slot, blockTime }: Pending): ListedSignature => ({
  signature: signature as ListedSignature["signature"],
  slot: BigInt(slot),
  blockTime: blockTime === null ? null : BigInt(blockTime),
  failed: false,
  memo: null,
});

const transient = (error: unknown): boolean => error instanceof RateLimited || error instanceof ReadTimedOut || error instanceof ReadFailed;

function decimalsOf(reader: Reader) {
  return async (mint: string): Promise<number | null> => {
    if (mint === NATIVE_MINT) {
      return SOL_DECIMALS;
    }
    try {
      return await reader.decimals(mint as Address);
    } catch (error) {
      if (transient(error)) {
        throw error;
      }
      return null;
    }
  };
}

export async function refreshInto(state: State, reader: Reader, deps: FeedDeps, now: number, deadline: AbortSignal): Promise<number> {
  const { limits, config } = deps;
  const fresh = await reader.newSignatures(limits.signaturePage, state.newest);
  const newest = fresh[0];
  if (newest !== undefined) {
    state.newest = newest.signature;
  }
  const queued = new Set(state.pending.map(({ signature }) => signature));
  const arrived = fresh
    .filter((entry) => !entry.failed && !queued.has(entry.signature))
    .reverse()
    .map((entry) => ({ signature: entry.signature, slot: Number(entry.slot), blockTime: entry.blockTime === null ? null : Number(entry.blockTime) }));
  state.pending.push(...arrived);
  if (state.slow_at === null || now - state.slow_at >= limits.accountsEverySecs * 1000) {
    applyOpenJobs(state, await reader.openJobs(), now);
    state.services = await servicesOf(reader, config, deps.probe, limits.serviceWindowSecs, now, deadline);
    state.slow_at = now;
  }
  const decimals = decimalsOf(reader);
  let added = 0;
  for (const entry of state.pending.slice(0, limits.transactionsPerRefresh)) {
    const transactions = await reader.transactions([listedOf(entry)]);
    for (const activity of transactions.flatMap((tx) => activitiesOf(tx, state.jobs))) {
      if (activity.mint !== null && activity.raw !== null && state.decimals[activity.mint] === undefined) {
        const places = await decimals(activity.mint);
        if (places !== null) {
          state.decimals[activity.mint] = places;
        }
      }
    }
    added += applyTransactions(state, transactions, config.house, now);
    state.pending = state.pending.slice(1);
  }
  return added;
}

export class LiveFeed {
  private readonly deps: FeedDeps;
  private checkedAt: number | null = null;
  private inflight: Promise<Feed> | null = null;

  constructor(deps: FeedDeps) {
    this.deps = deps;
  }

  read(): Promise<Feed> {
    if (this.inflight === null) {
      this.inflight = this.run().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async run(): Promise<Feed> {
    const { store, config, limits, log } = this.deps;
    const state = await store.load();
    const started = this.deps.now();
    if (this.checkedAt !== null && started - this.checkedAt < limits.maxAgeSecs * 1000) {
      return render(state, config.house, started);
    }
    if (state.retry_at !== null && started < state.retry_at) {
      log(JSON.stringify({ cluster: CLUSTER, refresh: "waiting", retry_in_secs: Math.ceil((state.retry_at - started) / 1000) }));
      return render(state, config.house, started);
    }
    this.checkedAt = started;
    const deadline = AbortSignal.timeout(limits.refreshBudgetMs);
    const next = structuredClone(state);
    try {
      const added = await raced(refreshInto(next, this.deps.connect(deadline), this.deps, started, deadline), deadline);
      next.stale_since = null;
      next.retry_at = null;
      pruned(next, started);
      const wrote = await store.save(next);
      log(JSON.stringify({ cluster: CLUSTER, refresh: "ok", events: added, pending: next.pending.length, wrote }));
      return render(next, config.house, started);
    } catch (error) {
      const failed = structuredClone(next);
      failed.stale_since = state.stale_since ?? new Date(started).toISOString();
      failed.retry_at = error instanceof RateLimited ? started + error.retryAfterSecs * 1000 : null;
      pruned(failed, started);
      const wrote = await store.save(failed);
      log(JSON.stringify({ cluster: CLUSTER, refresh: "stale", reason: error instanceof Error ? error.name : "unknown", ...(error instanceof RateLimited ? { method: error.method, retry_after_secs: error.retryAfterSecs } : {}), wrote }));
      return render(failed, config.house, started);
    }
  }
}
