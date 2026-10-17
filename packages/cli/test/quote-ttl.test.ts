import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Pricer, QuoteRequest } from "@intent-engine/solver";
import { MAX_FOLLOW_INTERVAL, parse, QUOTE_TTL, UsageError } from "../src/args.js";
import { watchPricer } from "../src/solve-commands.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;
const TAKER = "SysvarRent111111111111111111111111111111111" as Address;
const SOLVE = ["solve", "--keypair", "k", "--jupiter", "https://" + "q.example", "--min-profit", `${MINT}=1`];

function usage(argv: string[]): string {
  try {
    parse(argv, {});
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("no usage error");
}

function counted() {
  const seen: QuoteRequest[] = [];
  const pricer: Pricer = {
    async quote(request) {
      seen.push(request);
      return { amountIn: request.amountIn, amountOut: 1n, instructions: [], lookupTables: [] };
    },
  };
  return { seen, pricer };
}

const request: QuoteRequest = { inputMint: MINT, outputMint: MINT, amountIn: 5n, taker: TAKER };

describe("solve --quote-ttl", () => {
  it("defaults to ten seconds with --watch and takes zero", () => {
    expect(QUOTE_TTL).toBe(10);
    expect(parse([...SOLVE, "--watch"], {})).toMatchObject({ quoteTtl: 10 });
    expect(parse([...SOLVE, "--watch", "--quote-ttl", "0"], {})).toMatchObject({ quoteTtl: 0 });
    expect(parse([...SOLVE, "--watch", "--quote-ttl", String(MAX_FOLLOW_INTERVAL)], {})).toMatchObject({ quoteTtl: MAX_FOLLOW_INTERVAL });
    expect(usage([...SOLVE, "--watch", "--quote-ttl", String(MAX_FOLLOW_INTERVAL + 1)])).toBe(
      `--quote-ttl must be an integer from 0 to ${MAX_FOLLOW_INTERVAL}`,
    );
  });

  it("has no cache without --watch", () => {
    expect(parse(SOLVE, {})).not.toHaveProperty("quoteTtl");
    expect(usage([...SOLVE, "--quote-ttl", "5"])).toBe("--quote-ttl needs --watch");
  });

  it("asks every time with zero and stores quotes for the time limit otherwise", async () => {
    const off = counted();
    expect(watchPricer(off.pricer, 0, () => 0)).toBe(off.pricer);
    const time = { now: 0 };
    const on = counted();
    const cached = watchPricer(on.pricer, QUOTE_TTL, () => time.now);
    await cached.quote(request);
    time.now = QUOTE_TTL * 1_000 - 1;
    await cached.quote(request);
    expect(on.seen).toHaveLength(1);
    time.now = QUOTE_TTL * 1_000;
    await cached.quote(request);
    expect(on.seen).toHaveLength(2);
  });
});
