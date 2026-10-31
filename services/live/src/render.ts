import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { CLUSTER, PAID_WINDOW_SECS, SOL_DECIMALS, TOP_WORKERS } from "./limits.js";
import type { Feed, Paid, State, TokenAmount, TopWorker } from "./shapes.js";
import { amountText } from "./words.js";

function totals(paid: readonly Paid[]): TokenAmount[] {
  const sums = new Map<string, { raw: bigint; decimals: number }>();
  for (const entry of paid) {
    const known = sums.get(entry.token) ?? { raw: 0n, decimals: entry.decimals };
    known.raw += BigInt(entry.raw);
    sums.set(entry.token, known);
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([token, { raw, decimals }]) => ({ token, amount: amountText(raw, decimals) }));
}

function topWorkers(paid: readonly Paid[], house: ReadonlySet<string>): TopWorker[] {
  const workers = new Map<string, { jobs: number; sol: bigint; house: boolean }>();
  for (const entry of paid) {
    const known = workers.get(entry.payee) ?? { jobs: 0, sol: 0n, house: true };
    known.jobs += 1;
    known.house &&= entry.house;
    if (entry.token === "SOL") {
      known.sol += BigInt(entry.raw);
    }
    workers.set(entry.payee, known);
  }
  return [...workers.entries()]
    .sort(([a, x], [b, y]) => y.jobs - x.jobs || (y.sol > x.sol ? 1 : y.sol < x.sol ? -1 : a.localeCompare(b)))
    .slice(0, TOP_WORKERS)
    .map(([wallet, { jobs, sol, house: onlyHouse }]) => ({ wallet, paid_jobs: jobs, paid_sol: amountText(sol, SOL_DECIMALS), house: onlyHouse || house.has(wallet) }));
}

export function render(state: State, house: ReadonlySet<string>, now: number): Feed {
  const floor = now - PAID_WINDOW_SECS * 1000;
  const recent = state.paid.filter(({ at }) => Date.parse(at) >= floor);
  return {
    cluster: CLUSTER,
    generated_at: new Date(now).toISOString(),
    program: INTENT_ENGINE_PROGRAM_ADDRESS,
    last_event_at: state.events[0]?.at ?? null,
    stale: state.stale_since !== null,
    stale_since: state.stale_since,
    stats: {
      open_jobs: state.open_jobs,
      paid_jobs_7d: recent.length,
      workers_7d: new Set(recent.map(({ payee }) => payee)).size,
      paid_7d: totals(recent),
      house_paid_jobs_7d: recent.filter((entry) => entry.house).length,
    },
    events: state.events,
    latest_paid_job: state.latest_paid_job,
    top_workers: topWorkers(recent, house),
    services: state.services,
  };
}
