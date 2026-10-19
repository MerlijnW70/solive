import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { backoff, type Flight, FAILED_ON_CHAIN, heldBy, landings, releaseHolds, unheld } from "../src/index.js";

const FIRST = "11111111111111111111111111111112" as Address;
const SECOND = "So11111111111111111111111111111111111111112" as Address;
const THIRD = "SysvarC1ock11111111111111111111111111111111" as Address;
const STOCK = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

const intentOf = (status: Intent["status"]): Intent => ({ status, expiresAt: 1_000n }) as unknown as Intent;

const flying = (): Map<Address, Flight> =>
  new Map<Address, Flight>([
    [FIRST, { until: 10n, signature: "one", holds: { account: STOCK, amount: 30n } }],
    [SECOND, { until: 10n, signature: "two", holds: { account: STOCK, amount: 5n } }],
    [THIRD, { until: 10n, signature: "three", holds: { account: OTHER, amount: 7n } }],
  ]);

describe("inventory holds", () => {
  it("adds up what every flight holds back from one account and nothing from a route flight", () => {
    const flights = flying();
    flights.set(OTHER, { until: 10n, signature: "route" });
    const held = heldBy(flights);
    expect([held(STOCK), held(OTHER), held(FIRST)]).toEqual([35n, 7n, 0n]);
    flights.delete(FIRST);
    expect(held(STOCK)).toBe(5n);
  });

  it("never counts more free than the live balance and never less than nothing", () => {
    expect([unheld(100n, 30n), unheld(30n, 30n), unheld(10n, 30n), unheld(10n, 0n)]).toEqual([70n, 0n, 0n, 10n]);
  });

  it("ends a hold when its intent is listed as no longer open, and keeps the flight", () => {
    const flights = flying();
    releaseHolds(flights, [{ address: FIRST, intent: intentOf(IntentStatus.Filled) }, { address: SECOND, intent: intentOf(IntentStatus.Open) }], false);
    expect(flights.get(FIRST)).toEqual({ until: 10n, signature: "one" });
    expect(heldBy(flights)(STOCK)).toBe(5n);
    expect(heldBy(flights)(OTHER)).toBe(7n);
  });

  it("ends a hold when a full scan no longer lists its intent, but not when a changed scan leaves it out", () => {
    const changed = flying();
    releaseHolds(changed, [], false);
    expect(changed).toEqual(flying());
    const full = flying();
    releaseHolds(full, [{ address: SECOND, intent: intentOf(IntentStatus.Open) }], true);
    expect([heldBy(full)(STOCK), heldBy(full)(OTHER)]).toEqual([5n, 0n]);
    expect([...full.keys()]).toEqual([FIRST, SECOND, THIRD]);
  });

  it("ends a hold when its flight ends, whether the fill failed on chain or not", async () => {
    const flights = flying();
    const listed = [FIRST, SECOND, THIRD].map((address) => ({ address, intent: intentOf(IntentStatus.Open) }));
    const failedOnChain = async (signature: string) => signature === "one";
    expect(await landings(flights, 9n, listed, failedOnChain, backoff(3))).toEqual([]);
    expect(heldBy(flights)(STOCK)).toBe(35n);
    expect(await landings(flights, 10n, listed, failedOnChain, backoff(3))).toEqual([{ intent: FIRST, error: `${FAILED_ON_CHAIN}: one` }]);
    expect(flights.size).toBe(0);
    expect([heldBy(flights)(STOCK), heldBy(flights)(OTHER)]).toEqual([0n, 0n]);
  });

  it("ends a flight without calling it failed when the node cannot say how it went", async () => {
    const flights = flying();
    const listed = [FIRST].map((address) => ({ address, intent: intentOf(IntentStatus.Open) }));
    expect(await landings(flights, 10n, listed, async () => Promise.reject(new Error("rpc down")), backoff(3))).toEqual([]);
    expect([...flights.keys()]).toEqual([SECOND, THIRD]);
  });
});
