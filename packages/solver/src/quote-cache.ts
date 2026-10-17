import type { Pricer, Quote, QuoteRequest } from "./market.js";

export type QuoteCache = { ttlMs: number; clock: () => number };

const served = new WeakSet<Quote>();

export const fromCache = (quote: Quote): boolean => served.has(quote);

const keyOf = (request: QuoteRequest): string =>
  [request.inputMint, request.outputMint, request.amountIn.toString(), request.taker, request.maxAccounts ?? ""].join(":");

export function cachedPricer(pricer: Pricer, { ttlMs, clock }: QuoteCache): Pricer {
  const held = new Map<string, { at: number; quote: Quote | null }>();
  return {
    async quote(request) {
      const key = keyOf(request);
      const entry = held.get(key);
      if (request.fresh !== true && entry !== undefined && clock() - entry.at < ttlMs) {
        if (entry.quote === null) {
          return null;
        }
        const copy = { ...entry.quote };
        served.add(copy);
        return copy;
      }
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
