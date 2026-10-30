import { type Address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { computeUnitLimit, computeUnitPrice, headroom, MAX_COMPUTE_UNITS } from "@intent-engine/core/internal";
import { AUTO_PERCENTILE, AUTO_PRICE_CAP, budgeted, PACKET_DATA_SIZE, percentile, priceOf, transactionBytes } from "../src/budget.js";
import type { Transport } from "../src/transport.js";

const PROGRAM = "11111111111111111111111111111112" as Address;
const UNITS = 1_000n;

const ledger = (fees: readonly bigint[]) =>
  ({
    recentFees: async () => [...fees],
    latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n }),
    simulate: async () => ({ err: null, logs: [], unitsConsumed: UNITS, accounts: [] }),
  }) as unknown as Transport;

const sized = (bytes: number): Instruction => ({ programAddress: PROGRAM, accounts: [], data: new Uint8Array(bytes) });

describe("percentile of recent fees", () => {
  it("sorts the fees ascending and takes the entry at the rank", () => {
    expect(percentile([40n, 10n, 50n, 30n, 20n], 75n)).toBe(40n);
    expect(percentile([50n, 40n, 30n, 20n, 10n], 75n)).toBe(40n);
    expect(percentile([10n, 20n, 30n, 40n, 50n], 75n)).toBe(40n);
    expect(percentile([40n, 10n, 50n, 30n, 20n], 0n)).toBe(10n);
    expect(percentile([40n, 10n, 50n, 30n, 20n], 100n)).toBe(50n);
    expect(percentile([40n, 10n, 50n, 30n, 20n], 50n)).toBe(30n);
    expect(percentile([7n, 3n], 100n)).toBe(7n);
    expect(percentile([7n], 75n)).toBe(7n);
  });

  it("answers zero when there are no fees", () => {
    expect(percentile([], 75n)).toBe(0n);
    expect(percentile([], 0n)).toBe(0n);
  });

  it("does not reorder the fees it was given", () => {
    const fees = [3n, 1n, 2n];
    percentile(fees, 50n);
    expect(fees).toEqual([3n, 1n, 2n]);
  });
});

describe("the automatic price", () => {
  it("takes the percentile of the recent fees below the cap and the cap above it", async () => {
    expect(AUTO_PERCENTILE).toBe(75n);
    expect(await priceOf(ledger([4n, 1n, 3n, 2n]), "auto", [])).toBe(3n);
    expect(await priceOf(ledger([]), "auto", [])).toBe(0n);
    expect(await priceOf(ledger([AUTO_PRICE_CAP - 1n]), "auto", [])).toBe(AUTO_PRICE_CAP - 1n);
    expect(await priceOf(ledger([AUTO_PRICE_CAP]), "auto", [])).toBe(AUTO_PRICE_CAP);
    expect(await priceOf(ledger([AUTO_PRICE_CAP + 1n]), "auto", [])).toBe(AUTO_PRICE_CAP);
    expect(await priceOf(ledger([AUTO_PRICE_CAP * 5n]), "auto", [])).toBe(AUTO_PRICE_CAP);
  });

  it("returns a given price as it is", async () => {
    expect(await priceOf(ledger([9n]), 7n, [])).toBe(7n);
    expect(await priceOf(ledger([9n]), 0n, [])).toBe(0n);
  });
});

describe("the compute budget around a transaction", () => {
  it("adds a price instruction after the limit only for a price above zero", async () => {
    const payer = await generateKeyPairSigner();
    const ix = sized(8);
    expect(await budgeted(ledger([]), 0n, [ix], payer.address)).toEqual([ix, computeUnitLimit(headroom(UNITS))]);
    expect(await budgeted(ledger([]), 5n, [ix], payer.address)).toEqual([ix, computeUnitLimit(headroom(UNITS)), computeUnitPrice(5n)]);
    expect(await budgeted(ledger([4n, 1n, 3n, 2n]), "auto", [ix], payer.address)).toEqual([ix, computeUnitLimit(headroom(UNITS)), computeUnitPrice(3n)]);
    expect(await budgeted(ledger([]), "auto", [ix], payer.address)).toEqual([ix, computeUnitLimit(headroom(UNITS))]);
  });

  it("simulates a transaction of exactly one packet and skips simulation one byte above", async () => {
    const payer = await generateKeyPairSigner();
    const probe = 300;
    const base = await transactionBytes(ledger([]), [sized(probe), computeUnitLimit(MAX_COMPUTE_UNITS)], payer.address);
    const exact = sized(probe + PACKET_DATA_SIZE - base);
    const over = sized(probe + PACKET_DATA_SIZE - base + 1);
    expect(await transactionBytes(ledger([]), [exact, computeUnitLimit(MAX_COMPUTE_UNITS)], payer.address)).toBe(PACKET_DATA_SIZE);
    expect(await transactionBytes(ledger([]), [over, computeUnitLimit(MAX_COMPUTE_UNITS)], payer.address)).toBe(PACKET_DATA_SIZE + 1);
    expect(await budgeted(ledger([]), 0n, [exact], payer.address)).toEqual([exact, computeUnitLimit(headroom(UNITS))]);
    expect(await budgeted(ledger([]), 0n, [over], payer.address)).toEqual([over, computeUnitLimit(MAX_COMPUTE_UNITS)]);
  });
});
