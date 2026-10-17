import type { Address, Instruction } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { Fetch, FetchResponse, Pricer, Quote, QuoteRequest } from "../src/index.js";

describe("market contract", () => {
  it("asks a pricer for a quote by mints, exact input, taker, an optional account budget and an optional fresh flag", () => {
    expectTypeOf<QuoteRequest>().toEqualTypeOf<{
      inputMint: Address;
      outputMint: Address;
      amountIn: bigint;
      taker: Address;
      maxAccounts?: number;
      fresh?: boolean;
    }>();
    expectTypeOf<Pricer["quote"]>().parameters.toEqualTypeOf<[QuoteRequest]>();
    expectTypeOf<Pricer["quote"]>().returns.toEqualTypeOf<Promise<Quote | null>>();
  });

  it("returns a route as instructions with the lookup tables that compress them", () => {
    expectTypeOf<Quote>().toEqualTypeOf<{
      amountIn: bigint;
      amountOut: bigint;
      instructions: Instruction[];
      lookupTables: Address[];
    }>();
  });

  it("fetches with only a method, headers and a body, and reads only status and json", () => {
    expectTypeOf<Fetch>().toEqualTypeOf<
      (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>
    >();
    expectTypeOf<FetchResponse>().toEqualTypeOf<{ ok: boolean; status: number; json(): Promise<unknown> }>();
  });
});
