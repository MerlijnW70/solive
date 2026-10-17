import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { answered, backoff, type Flight, FAILED_ON_CHAIN, heldBy, type Landing, releaseHolds } from "../src/index.js";

const LANDED = "11111111111111111111111111111112" as Address;
const FAILED = "So11111111111111111111111111111111111111112" as Address;
const UNKNOWN = "SysvarC1ock11111111111111111111111111111111" as Address;
const STOCK = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;

const intentOf = (status: Intent["status"], nonce = 1n): Intent => ({ status, nonce, expiresAt: 1_000n }) as unknown as Intent;

const flying = (): Map<Address, Flight> =>
  new Map<Address, Flight>([
    [LANDED, { until: 10n, signature: "landed", holds: { account: STOCK, amount: 30n }, intent: intentOf(IntentStatus.Open) }],
    [FAILED, { until: 10n, signature: "failed", holds: { account: STOCK, amount: 5n }, intent: intentOf(IntentStatus.Open) }],
    [UNKNOWN, { until: 10n, signature: "unknown", holds: { account: STOCK, amount: 7n }, intent: intentOf(IntentStatus.Open) }],
  ]);

const answers: Record<string, Landing> = { landed: "landed", failed: "failed", unknown: null };

function asking(reply: (signatures: readonly string[]) => readonly Landing[] = (signatures) => signatures.map((s) => answers[s] ?? null)) {
  const calls: string[][] = [];
  return {
    calls,
    statuses: async (signatures: readonly string[]) => {
      calls.push([...signatures]);
      return reply(signatures);
    },
  };
}

describe("flight statuses", () => {
  it("asks once for every fill in flight, ends landed and failed flights with their holds, and keeps unknown ones", async () => {
    const flights = flying();
    const held = backoff(3, () => 0);
    const ask = asking();
    const failed = await answered(flights, [], ask.statuses, held);
    expect(ask.calls).toEqual([["landed", "failed", "unknown"]]);
    expect(failed).toEqual([{ intent: FAILED, error: `${FAILED_ON_CHAIN}: failed` }]);
    expect([...flights.keys()]).toEqual([UNKNOWN]);
    expect(heldBy(flights)(STOCK)).toBe(7n);
    expect(held.waiting(FAILED, intentOf(IntentStatus.Open))).toEqual({ failures: 1, seconds: 3 });
    expect(held.waiting(LANDED, intentOf(IntentStatus.Open))).toBeNull();
    expect(held.size()).toBe(1);
  });

  it("reports a failed fill only once and never treats an unknown one as failed", async () => {
    const flights = flying();
    const held = backoff(3, () => 0);
    const ask = asking();
    await answered(flights, [], ask.statuses, held);
    expect(await answered(flights, [], ask.statuses, held)).toEqual([]);
    expect(ask.calls).toEqual([["landed", "failed", "unknown"], ["unknown"]]);
    expect(held.size()).toBe(1);
    expect(flights.get(UNKNOWN)?.until).toBe(10n);
  });

  it("makes no call when nothing is in flight", async () => {
    const ask = asking();
    expect(await answered(new Map(), [], ask.statuses, backoff(3))).toEqual([]);
    expect(ask.calls).toEqual([]);
  });

  it("keeps every flight when the node cannot answer or answers short", async () => {
    const broken = flying();
    expect(await answered(broken, [], async () => Promise.reject(new Error("node down")), backoff(3))).toEqual([]);
    expect(broken).toEqual(flying());
    const short = flying();
    expect(await answered(short, [], asking(() => ["landed"]).statuses, backoff(3))).toEqual([]);
    expect([...short.keys()]).toEqual([FAILED, UNKNOWN]);
  });

  it("judges a failed fill by its listed intent, ending it unreported once the intent is no longer open", async () => {
    const flights = flying();
    const held = backoff(3, () => 0);
    const listed = [{ address: FAILED, intent: intentOf(IntentStatus.Filled) }];
    expect(await answered(flights, listed, asking().statuses, held)).toEqual([]);
    expect([...flights.keys()]).toEqual([UNKNOWN]);
    expect(held.size()).toBe(0);
    const changed = flying();
    const newer = intentOf(IntentStatus.Open, 2n);
    expect(await answered(changed, [{ address: FAILED, intent: newer }], asking().statuses, held)).toHaveLength(1);
    expect(held.waiting(FAILED, newer)).toEqual({ failures: 1, seconds: 3 });
  });

  it("leaves a failed fill in flight when no intent is known for it", async () => {
    const flights = new Map<Address, Flight>([[FAILED, { until: 10n, signature: "failed" }]]);
    expect(await answered(flights, [], asking().statuses, backoff(3))).toEqual([]);
    expect(flights.size).toBe(1);
  });

  it("keeps the sent intent on a flight whose hold ends early", () => {
    const flights = flying();
    releaseHolds(flights, [{ address: LANDED, intent: intentOf(IntentStatus.Filled) }], false);
    expect(flights.get(LANDED)).toEqual({ until: 10n, signature: "landed", intent: intentOf(IntentStatus.Open) });
  });
});
