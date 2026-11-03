import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ALREADY_FILLING,
  badConcurrency,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  RateLimited,
  SIMULATION_REFUSED,
} from "../src/index.js";
import { fresh, filledEntry, FLOOR, holding, many, MIN_OUT, NOW, order, type Order, paying, turns, until, world } from "./parallel-world.js";
import { unpricedWarning } from "./unpriced-warning.js";

describe("parallel planning", () => {
  it("defaults to 4 plans at a time and accepts 1 to 32", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
    expect(MAX_CONCURRENCY).toBe(32);
    expect(badConcurrency(0)).toBe("concurrency must be an integer from 1 to 32, not 0");
  });

  it("refuses a concurrency outside 1 to 32 before it reads the chain", async () => {
    const { output, orders } = await many(1);
    const w = await world(orders, output);
    for (const bad of [0, 33, 1.5, -1, Number.NaN]) {
      await expect(w.run({ concurrency: bad })).rejects.toThrow(badConcurrency(bad));
    }
    expect(w.configReads).toBe(0);
    for (const good of [1, 32]) {
      expect((await w.run({ concurrency: good })).filled).toHaveLength(1);
    }
  });

  it("never has more than concurrency plans in flight", async () => {
    const { output, orders } = await many(7);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run({ concurrency: 3 });
    await until(() => held.length === 3);
    await turns();
    expect(new Set(w.started).size).toBe(3);
    expect(w.sends).toEqual([]);
    for (let released = 0; released < orders.length; released += 1) {
      const due = Math.min(orders.length, released + 3);
      await until(() => held.length === due);
      await turns();
      expect(held.length).toBe(due);
      expect(new Set(w.started).size).toBe(due);
      held[released]?.release();
    }
    const report = await done;
    expect(report.filled).toEqual(orders.map((o) => filledEntry(o, 5n)));
    expect(w.maxPlanning).toBe(3);
    expect(new Set(w.started).size).toBe(orders.length);
  });

  it("plans 4 orders at a time when no concurrency is given", async () => {
    const { output, orders } = await many(6);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run();
    await until(() => held.length === 4);
    await turns();
    expect(new Set(w.started).size).toBe(4);
    for (let released = 0; released < orders.length; released += 1) {
      await until(() => held.length > released);
      held[released]?.release();
    }
    expect((await done).filled).toHaveLength(6);
    expect(w.maxPlanning).toBe(4);
  });

  it("simulates and sends one fill at a time, highest profit first, then soonest expiry, then lowest address", async () => {
    const output = await fresh();
    const low = await order(output);
    const late = await order(output, { expiresAt: NOW + 900n });
    const soon = await order(output, { expiresAt: NOW + 300n });
    const tieA = await order(output, { expiresAt: NOW + 300n });
    const tieB = await order(output, { expiresAt: NOW + 300n });
    const orders = [low, late, soon, tieA, tieB];
    const profits = new Map<Address, bigint>([
      [low.address, 5n],
      [late.address, 9n],
      [soon.address, 9n],
      [tieA.address, 3n],
      [tieB.address, 3n],
    ]);
    const w = await world(orders, output);
    w.quote = async (request, found) => paying(request, profits.get(found.address) ?? 0n);
    const report = await w.run({ concurrency: 5 });
    const ties = [tieA.address, tieB.address].toSorted((a, b) => (a < b ? -1 : 1));
    const expected = [soon.address, late.address, low.address, ...ties];
    expect(w.sends).toEqual(expected);
    expect(w.maxSending).toBe(1);
    expect(w.log).toEqual(expected.flatMap((address) => [`simulate ${address}`, `send ${address}`, `sent ${address}`]));
    expect(report).toEqual({
      filled: orders.map((o) => filledEntry(o, profits.get(o.address) ?? 0n)),
      sent: [],
      skipped: [],
      failed: [],
      warnings: unpricedWarning(output),
    });
  });

  it("stops starting plans once rate limited, lets running plans finish and skips the rest", async () => {
    const { output, orders } = await many(5);
    const w = await world(orders, output);
    const held = holding(w);
    const done = w.run({ concurrency: 2 });
    await until(() => held.length === 2);
    const [limited, running] = held;
    limited?.fail(new RateLimited());
    await turns();
    expect(new Set(w.started).size).toBe(2);
    running?.release();
    const report = await done;
    const reason = new RateLimited().message;
    expect(report).toEqual({
      filled: running === undefined ? [] : [filledEntry(running.order, 5n)],
      sent: [],
      skipped: orders.filter((o) => o !== running?.order).map((o) => ({ intent: o.address, reason })),
      failed: [],
      warnings: unpricedWarning(output),
    });
    expect(new Set(w.started).size).toBe(2);
    expect(held).toHaveLength(2);
  });

  it("sends nothing more once a send step is rate limited", async () => {
    const { output, orders } = await many(3);
    const w = await world(orders, output);
    w.failSimulation = () => {
      throw new RateLimited();
    };
    const report = await w.run();
    const reason = new RateLimited().message;
    expect(report).toEqual({ filled: [], sent: [], skipped: orders.map((o) => ({ intent: o.address, reason })), failed: [], warnings: unpricedWarning(output) });
    expect(w.log).toHaveLength(1);
    expect(w.sends).toEqual([]);
  });

  it("never sends two fills for one order in one tick", async () => {
    const { output, orders } = await many(1);
    const [only] = orders;
    if (only === undefined) {
      throw new Error("no order");
    }
    const w = await world([only, only], output);
    const report = await w.run();
    expect(report).toEqual({ filled: [filledEntry(only, 5n)], sent: [], skipped: [{ intent: only.address, reason: ALREADY_FILLING }], failed: [], warnings: unpricedWarning(output) });
    expect(w.sends).toEqual([only.address]);
  });

  it("with concurrency 1 plans one order after another and reports what the sequential solver reported", async () => {
    const scenario = async (concurrency: number) => {
      const output = await fresh();
      const good = await order(output);
      const thin = await order(output);
      const broken = await order(output);
      const rich = await order(output);
      const expired = await order(output, { expiresAt: NOW - 1n });
      const refused = await order(output);
      const orders = [good, thin, broken, rich, expired, refused];
      const w = await world(orders, output);
      const profits = new Map<Address, bigint>([
        [good.address, 3n],
        [thin.address, 1n],
        [rich.address, 9n],
        [refused.address, 4n],
      ]);
      w.quote = async (request, found) => {
        if (found === broken) {
          throw new Error("market unavailable");
        }
        return paying(request, profits.get(found.address) ?? 0n);
      };
      w.failSimulation = (found) => (found === refused ? "boom" : null);
      const report = await w.run({ concurrency });
      expect(report).toEqual({
        filled: [filledEntry(good, 3n), filledEntry(rich, 9n)],
        sent: [],
        skipped: [
          { intent: thin.address, reason: `profit 1 is below ${FLOOR}` },
          { intent: expired.address, reason: "expired" },
        ],
        failed: [
          { intent: broken.address, error: "market unavailable" },
          { intent: refused.address, error: `${SIMULATION_REFUSED}: boom` },
        ],
        warnings: unpricedWarning(output),
      });
      expect(w.sends).toEqual([rich.address, good.address]);
      return { w, orders: [good, thin, broken, rich, refused] };
    };
    const sequential = await scenario(1);
    expect(sequential.w.events).toEqual(sequential.orders.flatMap((o) => [`plan ${o.address}`, `quote ${o.address}`]));
    const parallel = await scenario(4);
    expect(parallel.w.events.slice(0, 4).every((event) => event.startsWith("plan "))).toBe(true);
  });
});
