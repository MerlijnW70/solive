import type { Pricer, Quote, QuoteRequest } from "./market.js";

export type QuoteCache = { ttlMs: number; clock: () => number };

export type CacheStats = { hits: number; misses: number };

export type CachedPricer = Pricer & { stats(): CacheStats };

export type CountingPricer = Pricer & { count(): number };

const served = new WeakSet<Quote>();

export const fromCache = (quote: Quote): boolean => served.has(quote);

export const freshly = (pricer: Pricer): Pricer => ({ quote: (request) => pricer.quote({ ...request, fresh: true }) });

const keyOf = (request: QuoteRequest): string =>
  [request.inputMint, request.outputMint, request.amountIn.toString(), request.taker, request.maxAccounts ?? ""].join(":");

export function countingPricer(pricer: Pricer): CountingPricer {
  let answered = 0;
  return {
    async quote(request) {
      const quote = await pricer.quote(request);
      answered += 1;
      return quote;
    },
    count: () => answered,
  };
}

export function cachedPricer(pricer: Pricer, { ttlMs, clock }: QuoteCache): CachedPricer {
  const held = new Map<string, { at: number; quote: Quote | null }>();
  const counts: CacheStats = { hits: 0, misses: 0 };
  return {
    stats: () => ({ ...counts }),
    async quote(request) {
      const key = keyOf(request);
      const entry = held.get(key);
      if (request.fresh !== true && entry !== undefined && clock() - entry.at < ttlMs) {
        counts.hits += 1;
        if (entry.quote === null) {
          return null;
        }
        const copy = { ...entry.quote };
        served.add(copy);
        return copy;
      }
      counts.misses += 1;
      const quote = await pricer.quote(request);
      const at = clock();
      for (const [old, stored] of held) {
        if (at - stored.at >= ttlMs) {
          held.delete(old);
        }
      }
      held.set(key, { at, quote });
      return quote;
    },
  };
}
