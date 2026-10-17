import type { Address } from "@solana/kit";
import { type CachedPricer, cachedPricer, countingPricer, type Pricer, type Report } from "@intent-engine/solver";

export type ScanStats = {
  orders: number;
  planned: number;
  quotes: number;
  cached: number;
  filled: number;
  sent: number;
  failed: number;
  skipped: Record<string, number>;
  ms: number;
};

export const skipKey = (reason: string): string => reason.replace(/\d+/g, "#");

export function skipCounts(skipped: readonly { reason: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { reason } of skipped) {
    const key = skipKey(reason);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export type Tally = {
  pricer: Pricer;
  planned(intent: Address): void;
  mark(): (scan: { orders: number; report: Report; lost: number; ms: number }) => ScanStats;
};

export function tally(pricer: Pricer, ttlSeconds: number, clock: () => number): Tally {
  const counting = countingPricer(pricer);
  const cache: CachedPricer | null = ttlSeconds === 0 ? null : cachedPricer(counting, { ttlMs: ttlSeconds * 1_000, clock });
  let planned = 0;
  return {
    pricer: cache ?? counting,
    planned: () => {
      planned += 1;
    },
    mark: () => {
      const before = { planned, quotes: counting.count(), cached: cache?.stats().hits ?? 0 };
      return ({ orders, report, lost, ms }) => ({
        orders,
        planned: planned - before.planned,
        quotes: counting.count() - before.quotes,
        cached: (cache?.stats().hits ?? 0) - before.cached,
        filled: report.filled.length,
        sent: report.sent.length,
        failed: report.failed.length + lost,
        skipped: skipCounts(report.skipped),
        ms,
      });
    },
  };
}
