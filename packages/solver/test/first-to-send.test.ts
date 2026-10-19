import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { firstToSend, type Plan } from "../src/index.js";

const LOW = "11111111111111111111111111111112" as Address;
const HIGH = "SysvarC1ock11111111111111111111111111111111" as Address;

const plan = (profit: bigint, expiresAt: bigint, address: Address): Plan => ({ profit, intent: { expiresAt }, address }) as unknown as Plan;

describe("the fill order", () => {
  it("sends the most profitable fill first, then the one expiring soonest, then by address", () => {
    const sign = (a: Plan, b: Plan) => Math.sign(firstToSend(a, b));
    expect([sign(plan(5n, 9n, HIGH), plan(3n, 1n, LOW)), sign(plan(3n, 1n, LOW), plan(5n, 9n, HIGH))]).toEqual([-1, 1]);
    expect([sign(plan(5n, 1n, HIGH), plan(5n, 9n, LOW)), sign(plan(5n, 9n, LOW), plan(5n, 1n, HIGH))]).toEqual([-1, 1]);
    expect([sign(plan(5n, 1n, LOW), plan(5n, 1n, HIGH)), sign(plan(5n, 1n, HIGH), plan(5n, 1n, LOW))]).toEqual([-1, 1]);
    expect(firstToSend(plan(5n, 1n, LOW), plan(5n, 1n, LOW))).toBe(0);
  });
});
