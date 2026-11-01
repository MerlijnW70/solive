import { describe, expect, it } from "vitest";
import type { Feed } from "../src/shapes.js";
import { FEED_TRANSACTIONS_PER_REFRESH, STATE_KEY } from "../src/limits.js";
import { chainOf, configOf, inWindow, listings, olderListings, paidIn, readSignatures, sig, stored, tooMany, untilComplete } from "./history-chain.js";
import { type MemoryCache, rig } from "./harness.js";

describe("backfill on an empty cache", () => {
  it("counts every paid job of the window and nothing older once the history is complete", async () => {
    const txs = chainOf(300);
    const { node, feed, tick, clock, cache } = rig();
    node.add(...txs);
    const seen: Feed[] = [];
    let draining = 0;
    for (let refresh = 0; refresh < 40 && seen.at(-1)?.history.complete !== true; refresh++) {
      if (refresh > 0) {
        tick(31);
      }
      const body = await feed.read();
      seen.push(body);
      const saved = stored(cache);
      if (saved.backfilled === true && (saved.backlog ?? []).length > 0) {
        draining += 1;
        expect(body.history.complete).toBe(false);
      }
    }
    expect(draining).toBeGreaterThan(0);
    expect(olderListings(node.calls).map((call) => configOf(call).before)).toEqual([sig(201), sig(101)]);
    const last = seen.at(-1);
    expect(last?.history.complete).toBe(true);
    const expected = paidIn(txs, clock.at);
    expect(expected).toBeGreaterThan(paidIn(txs.slice(-100), clock.at));
    expect(last?.stats.paid_jobs_7d).toBe(expected);
    expect(seen[0]?.stats.paid_jobs_7d).toBeLessThan(expected);
    const older = new Set(txs.filter((tx) => !inWindow(tx, clock.at)).map(({ signature }) => signature));
    expect(older.size).toBeGreaterThan(0);
    expect(readSignatures(node.calls).filter((signature) => older.has(signature))).toEqual([]);
    expect(new Set(readSignatures(node.calls)).size).toBe(readSignatures(node.calls).length);
    tick(31);
    const after = await feed.read();
    expect(after.stats.paid_jobs_7d).toBe(expected);
  });

  it("keeps the call budget per refresh: one listing and at most FEED_TRANSACTIONS_PER_REFRESH reads, or one read fewer when it lists older ones", async () => {
    const { node, feed, tick } = rig();
    node.add(...chainOf(300));
    let backfilled = 0;
    for (let refresh = 0; refresh < 40; refresh++) {
      const from = node.calls.length;
      const body = await feed.read();
      const calls = node.calls.slice(from);
      const listed = listings(calls).length;
      const reads = readSignatures(calls).length;
      expect(listed + reads).toBeLessThanOrEqual(1 + FEED_TRANSACTIONS_PER_REFRESH);
      expect(reads).toBeLessThanOrEqual(FEED_TRANSACTIONS_PER_REFRESH);
      if (listed === 2) {
        backfilled += 1;
        expect(reads).toBeLessThanOrEqual(FEED_TRANSACTIONS_PER_REFRESH - 1);
      }
      if (body.history.complete) {
        break;
      }
      tick(31);
    }
    expect(backfilled).toBeGreaterThan(0);
  });

  it("resumes where it stopped, across refreshes and a cold instance", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const txs = chainOf(60);
    const first = rig({ limits });
    first.node.add(...txs);
    for (let refresh = 0; refresh < 6; refresh++) {
      await first.feed.read();
      first.tick(31);
    }
    const cursor = stored(first.cache).oldest;
    expect(cursor).toBeTruthy();
    expect(stored(first.cache).backfilled).toBe(false);
    const cold = rig({ limits }, first);
    const listedBefore = listings(first.node.calls).length;
    await untilComplete(cold.feed, cold.tick, 60);
    const resumed = listings(first.node.calls).slice(listedBefore).filter((call) => configOf(call).before !== undefined);
    expect(configOf(resumed[0]).before).toBe(cursor);
    const befores = olderListings(first.node.calls).map((call) => configOf(call).before);
    expect(new Set(befores).size).toBe(befores.length);
    const reads = readSignatures(first.node.calls);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("reads new activity before backfill in the same refresh", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const txs = chainOf(40);
    const { node, feed, tick, cache } = rig({ limits });
    node.add(...txs.slice(0, 38));
    for (let refresh = 0; refresh < 3; refresh++) {
      await feed.read();
      tick(31);
    }
    const backlog = stored(cache).backlog ?? [];
    expect(backlog.length).toBeGreaterThan(3);
    node.add(...txs.slice(38));
    const from = node.calls.length;
    await feed.read();
    const reads = readSignatures(node.calls.slice(from));
    expect(reads).toEqual([sig(39), sig(40), ...backlog.slice(0, 3).map(({ signature }) => signature)]);
  });

  it("reads new activity before it lists an older page in the same refresh", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const txs = chainOf(29);
    const { node, feed, tick } = rig({ limits });
    node.add(...txs.slice(0, 28));
    for (let refresh = 0; refresh < 4; refresh++) {
      await feed.read();
      tick(31);
    }
    node.add(...txs.slice(28));
    const from = node.calls.length;
    await feed.read();
    const calls = node.calls.slice(from).filter(({ method }) => method === "getTransaction" || method === "getSignaturesForAddress");
    const steps = calls.map((call) => (call.method === "getTransaction" ? (call.params[0] as string) : configOf(call).before !== undefined ? "older" : "newer"));
    expect(steps).toEqual(["newer", sig(29), "older", sig(1), sig(2), sig(3)]);
  });

  it("lists no older page while new activity fills the reads", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const { node, feed, tick } = rig({ limits });
    node.add(...chainOf(40));
    await feed.read();
    tick(31);
    await feed.read();
    expect(olderListings(node.calls)).toEqual([]);
    tick(31);
    await feed.read();
    expect(olderListings(node.calls)).toHaveLength(1);
  });

  it("keeps what it read when a 429 hits mid-backfill, sets retry_at and goes on after it", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const txs = chainOf(40);
    const { node, feed, tick, cache, clock } = rig({ limits });
    node.add(...txs);
    for (let refresh = 0; refresh < 3; refresh++) {
      await feed.read();
      tick(31);
    }
    const before = stored(cache);
    expect(before.backlog?.length).toBe(6);
    let reads = 0;
    node.fail = (call) => (call.method === "getTransaction" && ++reads === 3 ? tooMany("7") : undefined);
    const cut = await feed.read();
    expect(cut.stale).toBe(true);
    const after = stored(cache);
    expect(after.retry_at).toBe(clock.at + 7000);
    expect(after.backlog?.map(({ signature }) => signature)).toEqual(before.backlog?.slice(2).map(({ signature }) => signature));
    expect(after.oldest).toBe(before.oldest);
    const kept = before.backlog?.slice(0, 2).map(({ signature }) => signature) ?? [];
    expect(cut.events.filter(({ signature }) => kept.includes(signature))).toHaveLength(2);
    node.fail = (call) => (listings([call]).length === 1 && configOf(call).before !== undefined ? tooMany("9") : undefined);
    tick(31);
    const listingCut = await feed.read();
    expect(listingCut.stale).toBe(true);
    expect(stored(cache).retry_at).toBe(clock.at + 9000);
    expect(stored(cache).oldest).toBe(before.oldest);
    expect(stored(cache).backlog).toEqual(after.backlog);
    node.fail = null;
    tick(31);
    const seen = await untilComplete(feed, tick, 40);
    expect(seen.at(-1)?.history.complete).toBe(true);
    expect(seen.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, clock.at));
  });
});

describe("history in the JSON", () => {
  it("marks the history as filling, with how far back it reaches, and then as complete", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 5 };
    const txs = chainOf(30);
    const { node, feed, tick } = rig({ limits });
    node.add(...txs);
    const first = await feed.read();
    expect(first.history).toEqual({ complete: false, since: new Date((txs[20]?.blockTime ?? 0) * 1000).toISOString() });
    const seen = await untilComplete(feed, tick, 40);
    const filling = seen.filter(({ history }) => !history.complete);
    expect(filling.length).toBeGreaterThan(1);
    const reaches = filling.map(({ history }) => Date.parse(history.since ?? ""));
    expect([...reaches].sort((a, b) => b - a)).toEqual(reaches);
    expect(seen.at(-1)?.history).toEqual({ complete: true, since: new Date((txs[0]?.blockTime ?? 0) * 1000).toISOString() });
  });

  it("is complete after one refresh when the first page holds the whole history", async () => {
    const txs = chainOf(260).slice(0, 15);
    const { node, feed } = rig();
    node.add(...txs);
    expect((await feed.read()).history).toEqual({ complete: true, since: new Date((txs[0]?.blockTime ?? 0) * 1000).toISOString() });
  });
});

describe("state saved by the current version", () => {
  const strip = (cache: MemoryCache): void => {
    const state = stored(cache) as Record<string, unknown>;
    for (const key of ["backlog", "oldest", "oldest_at", "backfilled"]) {
      delete state[key];
    }
    cache.values.set(STATE_KEY, JSON.stringify(state));
  };

  it("loads and starts no backfill when its events reach past the window", async () => {
    const txs = chainOf(260);
    const first = rig();
    first.node.add(...txs.slice(0, 10));
    await first.feed.read();
    strip(first.cache);
    const cold = rig({}, first);
    const served = await cold.feed.read();
    expect(configOf(listings(first.node.calls).at(-1)).until).toBe(sig(10));
    expect(served.events).toHaveLength(10);
    expect(served.history.complete).toBe(true);
    first.node.add(...txs.slice(10, 12));
    cold.tick(31);
    const body = await cold.feed.read();
    expect(body.history.complete).toBe(true);
    expect(olderListings(first.node.calls)).toEqual([]);
    expect(stored(first.cache).backfilled).toBe(true);
  });

  it("loads, backfills from its oldest event when its history is shorter than the window, and counts nothing twice", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 20 };
    const txs = chainOf(40);
    const first = rig({ limits });
    first.node.add(...txs);
    await first.feed.read();
    strip(first.cache);
    const cold = rig({ limits }, first);
    cold.tick(31);
    const seen = await untilComplete(cold.feed, cold.tick, 40);
    expect(configOf(olderListings(first.node.calls)[0]).before).toBe(sig(31));
    expect(seen.at(-1)?.history.complete).toBe(true);
    expect(seen.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, first.clock.at));
  });

  it("re-reads from the top when it holds no event, without counting a release twice", async () => {
    const limits = { signaturePage: 10, transactionsPerRefresh: 20 };
    const txs = chainOf(25);
    const first = rig({ limits });
    first.node.add(...txs);
    await first.feed.read();
    const state = stored(first.cache);
    state.events = [];
    first.cache.values.set(STATE_KEY, JSON.stringify(state));
    strip(first.cache);
    const cold = rig({ limits }, first);
    cold.tick(31);
    const seen = await untilComplete(cold.feed, cold.tick, 40);
    expect(configOf(olderListings(first.node.calls)[0])).not.toHaveProperty("before");
    expect(seen.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, first.clock.at));
    expect(new Set(seen.at(-1)?.events.map(({ signature, kind }) => signature + kind)).size).toBe(seen.at(-1)?.events.length);
  });
});
