import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { firstPricer, inventoryPricer, type Pricer, type Quote, type QuoteRequest } from "../src/index.js";

const TAKER = "11111111111111111111111111111112" as Address;
const INPUT = "So11111111111111111111111111111111111111112" as Address;
const OUTPUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const OTHER = "SysvarC1ock11111111111111111111111111111111" as Address;
const route = { inputMint: INPUT, outputMint: OUTPUT, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 200n, in: 3n };
const request: QuoteRequest = { inputMint: INPUT, outputMint: OUTPUT, amountIn: 10n, taker: TAKER };

describe("the inventory pricer", () => {
  it("quotes the configured rate with no route instructions when the solver holds enough of the output", async () => {
    const asked: Address[] = [];
    const pricer = inventoryPricer([route], async (mint) => {
      asked.push(mint);
      return 666n;
    });
    expect(await pricer.quote(request)).toEqual({ amountIn: 10n, amountOut: 666n, instructions: [], lookupTables: [], inventory: true });
    expect(asked).toEqual([OUTPUT]);
  });

  it("quotes nothing when the balance is short of the amount out", async () => {
    expect(await inventoryPricer([route], async () => 665n).quote(request)).toBeNull();
    expect(await inventoryPricer([route], async () => 0n).quote(request)).toBeNull();
  });

  it("quotes no route for any other pair and never reads a balance for it", async () => {
    const asked: Address[] = [];
    const pricer = inventoryPricer([route], async (mint) => {
      asked.push(mint);
      return 1_000_000n;
    });
    expect(await pricer.quote({ ...request, inputMint: OUTPUT, outputMint: INPUT })).toBeNull();
    expect(await pricer.quote({ ...request, outputMint: OTHER })).toBeNull();
    expect(await pricer.quote({ ...request, inputMint: OTHER })).toBeNull();
    expect(asked).toEqual([]);
  });

  it("refuses a rate that is not positive on both sides", () => {
    const held = async () => 0n;
    expect(() => inventoryPricer([{ ...route, out: 0n }], held)).toThrow(RangeError);
    expect(() => inventoryPricer([{ ...route, in: 0n }], held)).toThrow(RangeError);
    expect(() => inventoryPricer([route, { ...route, outputMint: OTHER, in: -1n }], held)).toThrow(RangeError);
  });
});

describe("the first pricer", () => {
  const quoted = (amountOut: bigint): Quote => ({ amountIn: 10n, amountOut, instructions: [], lookupTables: [] });
  const recording = (name: string, answer: Quote | null, calls: string[]): Pricer => ({
    async quote() {
      calls.push(name);
      return answer;
    },
  });

  it("returns the first quote and asks no pricer after it", async () => {
    const calls: string[] = [];
    const pricer = firstPricer(recording("a", quoted(1n), calls), recording("b", quoted(2n), calls));
    expect(await pricer.quote(request)).toEqual(quoted(1n));
    expect(calls).toEqual(["a"]);
  });

  it("falls through pricers that quote nothing, in order", async () => {
    const calls: string[] = [];
    const pricer = firstPricer(recording("a", null, calls), recording("b", null, calls), recording("c", quoted(3n), calls), recording("d", quoted(4n), calls));
    expect(await pricer.quote(request)).toEqual(quoted(3n));
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("quotes nothing when every pricer, or no pricer, quotes nothing", async () => {
    const calls: string[] = [];
    expect(await firstPricer(recording("a", null, calls), recording("b", null, calls)).quote(request)).toBeNull();
    expect(calls).toEqual(["a", "b"]);
    expect(await firstPricer().quote(request)).toBeNull();
  });

  it("passes each pricer the request it was given", async () => {
    const seen: QuoteRequest[] = [];
    const pricer = firstPricer({
      async quote(r) {
        seen.push(r);
        return null;
      },
    });
    await pricer.quote({ ...request, maxAccounts: 20 });
    expect(seen).toEqual([{ ...request, maxAccounts: 20 }]);
  });
});
