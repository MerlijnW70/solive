import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { cachedPricer, countingPricer, fromCache, type Pricer, type Quote, type QuoteRequest } from "../src/index.js";

const IN = "11111111111111111111111111111112" as Address;
const OUT = "SysvarC1ock11111111111111111111111111111111" as Address;
const TAKER = "SysvarRent111111111111111111111111111111111" as Address;
const OTHER = "SysvarS1otHashes111111111111111111111111111" as Address;

const request = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  inputMint: IN,
  outputMint: OUT,
  amountIn: 1_000n,
  taker: TAKER,
  maxAccounts: 40,
  ...over,
});

const quoteOf = (amountOut: bigint): Quote => ({ amountIn: 1_000n, amountOut, instructions: [], lookupTables: [] });

function setup(answer: (asked: number) => Quote | null | Error = (asked) => quoteOf(BigInt(asked)), ttlMs = 10_000) {
  const time = { now: 1_000 };
  const seen: QuoteRequest[] = [];
  const pricer: Pricer = {
    async quote(asked) {
      seen.push(asked);
      const out = answer(seen.length);
      if (out instanceof Error) {
        throw out;
      }
      return out;
    },
  };
  const cached = cachedPricer(pricer, { ttlMs, clock: () => time.now });
  return { time, seen, cached };
}

const stored = (quote: Quote | null): boolean | null => (quote === null ? null : fromCache(quote));

describe("quote cache", () => {
  it("asks the wrapped pricer once for a repeat request inside the time limit", async () => {
    const { time, seen, cached } = setup();
    const first = await cached.quote(request());
    time.now += 9_999;
    const again = await cached.quote(request());
    expect(seen).toHaveLength(1);
    expect(again?.amountOut).toBe(1n);
    expect([stored(first), stored(again)]).toEqual([false, true]);
  });

  it("asks again once the stored quote is as old as the time limit", async () => {
    const { time, seen, cached } = setup();
    await cached.quote(request());
    time.now += 10_000;
    const again = await cached.quote(request());
    expect(seen).toHaveLength(2);
    expect(again?.amountOut).toBe(2n);
    expect(stored(again)).toBe(false);
  });

  it("asks again for a different amount, account budget, taker or mints", async () => {
    const { seen, cached } = setup();
    await cached.quote(request());
    await cached.quote(request({ amountIn: 1_001n }));
    await cached.quote(request({ maxAccounts: 30 }));
    const unbounded = request();
    delete unbounded.maxAccounts;
    await cached.quote(unbounded);
    await cached.quote(request({ taker: OTHER }));
    await cached.quote(request({ inputMint: OTHER }));
    await cached.quote(request({ outputMint: OTHER }));
    expect(seen).toHaveLength(7);
    await cached.quote(request({ maxAccounts: 30 }));
    await cached.quote(request({ amountIn: 1_001n }));
    expect(seen).toHaveLength(7);
  });

  it("stores no route too", async () => {
    const { seen, cached } = setup(() => null);
    expect(await cached.quote(request())).toBeNull();
    expect(await cached.quote(request())).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("does not store a failed request", async () => {
    const { seen, cached } = setup((asked) => (asked === 1 ? new Error("market down") : quoteOf(7n)));
    await expect(cached.quote(request())).rejects.toThrow("market down");
    expect((await cached.quote(request()))?.amountOut).toBe(7n);
    expect((await cached.quote(request()))?.amountOut).toBe(7n);
    expect(seen).toHaveLength(2);
  });

  it("asks the wrapped pricer for a fresh request and stores what it answers", async () => {
    const { seen, cached } = setup();
    await cached.quote(request());
    const fresh = await cached.quote(request({ fresh: true }));
    expect(fresh?.amountOut).toBe(2n);
    expect(stored(fresh)).toBe(false);
    expect(seen.map((asked) => asked.fresh)).toEqual([undefined, true]);
    const after = await cached.quote(request());
    expect([after?.amountOut, stored(after)]).toEqual([2n, true]);
    expect(seen).toHaveLength(2);
  });

  it("stores nothing with a time limit of zero", async () => {
    const { seen, cached } = setup(undefined, 0);
    await cached.quote(request());
    await cached.quote(request());
    expect(seen).toHaveLength(2);
  });

  it("counts hits and misses since it was made", async () => {
    const { time, cached } = setup((asked) => (asked === 2 ? new Error("market down") : quoteOf(BigInt(asked))));
    expect(cached.stats()).toEqual({ hits: 0, misses: 0 });
    await cached.quote(request());
    await cached.quote(request());
    await expect(cached.quote(request({ amountIn: 2n }))).rejects.toThrow("market down");
    await cached.quote(request({ fresh: true }));
    await cached.quote(request());
    time.now += 10_000;
    await cached.quote(request());
    const snapshot = cached.stats();
    snapshot.hits = 99;
    expect(cached.stats()).toEqual({ hits: 2, misses: 4 });
  });
});

describe("counting pricer", () => {
  it("counts the requests the wrapped pricer answered, with or without a route", async () => {
    const answers: (Quote | null | Error)[] = [quoteOf(1n), null, new Error("market down"), quoteOf(2n)];
    const pricer: Pricer = {
      async quote() {
        const out = answers.shift() ?? null;
        if (out instanceof Error) {
          throw out;
        }
        return out;
      },
    };
    const counting = countingPricer(pricer);
    expect(counting.count()).toBe(0);
    expect((await counting.quote(request()))?.amountOut).toBe(1n);
    expect(await counting.quote(request())).toBeNull();
    await expect(counting.quote(request())).rejects.toThrow("market down");
    expect(counting.count()).toBe(2);
    expect((await counting.quote(request()))?.amountOut).toBe(2n);
    expect(counting.count()).toBe(3);
  });
});
