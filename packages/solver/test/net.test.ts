import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type Intent, NATIVE_MINT } from "@intent-engine/core";
import { badSolValue, costIn, NET_BELOW_FLOOR, netBelowFloor, netShort, solValueFits } from "../src/index.js";

const TOKEN = "SysvarC1ock11111111111111111111111111111111" as Address;
const OTHER = "SysvarRent111111111111111111111111111111111" as Address;

const plan = (outputMint: Address, profit: bigint) => ({ intent: { outputMint } as Intent, profit });

describe("a fill's sol cost in its output token", () => {
  it("counts wrapped SOL at its own lamports without an entry, and ignores an entry for it", () => {
    expect(costIn(NATIVE_MINT, 15_000n, undefined)).toBe(15_000n);
    expect(costIn(NATIVE_MINT, 15_000n, new Map([[NATIVE_MINT, { raw: 1n, lamports: 1_000n }]]))).toBe(15_000n);
  });

  it("converts a mint with an entry and rounds up", () => {
    const values = new Map([[TOKEN, { raw: 1n, lamports: 3n }]]);
    expect(costIn(TOKEN, 10_000n, values)).toBe(3_334n);
    expect(costIn(TOKEN, 9_999n, values)).toBe(3_333n);
    expect(costIn(TOKEN, 0n, values)).toBe(0n);
    expect(costIn(TOKEN, 7n, new Map([[TOKEN, { raw: 200n, lamports: 1n }]]))).toBe(1_400n);
    expect(costIn(TOKEN, 1n, new Map([[TOKEN, { raw: 1n, lamports: 1_000_000n }]]))).toBe(1n);
  });

  it("has no cost for a mint without an entry", () => {
    expect(costIn(OTHER, 10_000n, new Map([[TOKEN, { raw: 1n, lamports: 3n }]]))).toBeNull();
    expect(costIn(OTHER, 10_000n, undefined)).toBeNull();
  });

  it("skips only when the profit less the cost is below the floor, and states profit, cost and floor", () => {
    expect(netShort(plan(NATIVE_MINT, 11_000n), 1_000n, 10_000n, undefined)).toBeNull();
    expect(netShort(plan(NATIVE_MINT, 10_999n), 1_000n, 10_000n, undefined)).toBe(netBelowFloor(10_999n, 10_000n, 10_000n, 1_000n));
    expect(netBelowFloor(10_999n, 3_334n, 10_000n, 1_000n)).toBe(
      `${NET_BELOW_FLOOR}: profit 10999 less a cost of 3334 (10000 lamports) is below the floor of 1000`,
    );
    const values = new Map([[TOKEN, { raw: 1n, lamports: 3n }]]);
    expect(netShort(plan(TOKEN, 4_334n), 1_000n, 10_000n, values)).toBeNull();
    expect(netShort(plan(TOKEN, 4_333n), 1_000n, 10_000n, values)).toBe(netBelowFloor(4_333n, 3_334n, 10_000n, 1_000n));
    expect(netShort(plan(OTHER, 1_000n), 1_000n, 10_000_000n, values)).toBeNull();
  });

  it("refuses a sol value that is not positive on both sides", () => {
    expect(solValueFits(undefined)).toBeNull();
    expect(solValueFits(new Map([[TOKEN, { raw: 1n, lamports: 1n }]]))).toBeNull();
    expect(solValueFits(new Map([[TOKEN, { raw: 0n, lamports: 1n }]]))).toBe(badSolValue(TOKEN));
    expect(solValueFits(new Map([[TOKEN, { raw: 1n, lamports: 0n }]]))).toBe(badSolValue(TOKEN));
    expect(solValueFits(new Map([[TOKEN, { raw: 1n, lamports: -1n }]]))).toBe(badSolValue(TOKEN));
  });
});
