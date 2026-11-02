import { describe, expect, it } from "vitest";
import { FEED_TRANSACTIONS_PER_REFRESH } from "../src/limits.js";
import type { Feed, State } from "../src/shapes.js";
import { chainOf, configOf, listings, paidIn, readSignatures, sig, stored } from "./history-chain.js";
import { rig } from "./harness.js";

type Rigged = ReturnType<typeof rig>;

const SMALL = { signaturePage: 10, transactionsPerRefresh: 5 };

const gapListings = (calls: Rigged["node"]["calls"]) => listings(calls).filter((call) => configOf(call).before !== undefined && configOf(call).until !== undefined);

async function drain(feed: Rigged["feed"], tick: Rigged["tick"], cache: Rigged["cache"], most: number): Promise<{ bodies: Feed[]; states: State[] }> {
  const bodies: Feed[] = [];
  const states: State[] = [];
  for (let refresh = 0; refresh < most; refresh++) {
    tick(31);
    bodies.push(await feed.read());
    const state = stored(cache);
    states.push(state);
    if (bodies.at(-1)?.history.complete === true && state.pending.length === 0) {
      break;
    }
  }
  return { bodies, states };
}

async function burst(total: number, before: number, limits: Partial<typeof SMALL> = SMALL) {
  const txs = chainOf(total);
  const rigged = rig({ limits });
  rigged.node.add(...txs.slice(0, before));
  const opening = await rigged.feed.read();
  expect(opening.history.complete).toBe(true);
  rigged.node.add(...txs.slice(before));
  return { ...rigged, txs };
}

describe("a burst of more than one page between two refreshes", () => {
  it("ends with every signature read and every paid job counted, and moves the cursor only once the walk ends", async () => {
    const { node, feed, tick, cache, clock, txs } = await burst(40, 5);
    const { bodies, states } = await drain(feed, tick, cache, 40);
    expect(new Set(readSignatures(node.calls))).toEqual(new Set(txs.map(({ signature }) => signature)));
    expect(bodies.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, clock.at));
    expect(paidIn(txs, clock.at)).toBeGreaterThan(paidIn(txs.slice(-10), clock.at) + paidIn(txs.slice(0, 5), clock.at));
    const walking = states.filter((state) => (state.gaps ?? []).length > 0);
    expect(walking.length).toBeGreaterThan(1);
    expect(walking.map(({ newest }) => newest)).toEqual(walking.map(() => sig(5)));
    expect(walking.map(({ top }) => top)).toEqual(walking.map(() => sig(40)));
    expect(states.at(-1)?.newest).toBe(sig(40));
    expect(states.at(-1)?.gaps).toEqual([]);
    expect(gapListings(node.calls).map((call) => [configOf(call).before, configOf(call).until])).toEqual([
      [sig(31), sig(5)],
      [sig(21), sig(5)],
      [sig(11), sig(5)],
    ]);
    expect(new Set(readSignatures(node.calls)).size).toBe(readSignatures(node.calls).length);
  });

  it("resumes the walk across refreshes and a cold instance", async () => {
    const first = await burst(60, 5);
    for (let refresh = 0; refresh < 4; refresh++) {
      first.tick(31);
      await first.feed.read();
    }
    const gaps = stored(first.cache).gaps ?? [];
    expect(gaps.map(({ before, until }) => [before, until])).toEqual([[sig(41), sig(5)]]);
    const listedBefore = gapListings(first.node.calls).length;
    const cold = rig({ limits: SMALL }, first);
    const { bodies } = await drain(cold.feed, cold.tick, first.cache, 60);
    const resumed = gapListings(first.node.calls).slice(listedBefore);
    expect(configOf(resumed[0]).before).toBe(sig(41));
    expect(configOf(resumed[0]).until).toBe(sig(5));
    const befores = gapListings(first.node.calls).map((call) => configOf(call).before);
    expect(new Set(befores).size).toBe(befores.length);
    const reads = readSignatures(first.node.calls);
    expect(new Set(reads).size).toBe(reads.length);
    expect(new Set(reads)).toEqual(new Set(first.txs.map(({ signature }) => signature)));
    expect(bodies.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(first.txs, first.clock.at));
  });

  it("stops at the window edge", async () => {
    const { node, feed, tick, cache, clock, txs } = await burst(300, 3, { signaturePage: 10, transactionsPerRefresh: 20 });
    const { bodies, states } = await drain(feed, tick, cache, 40);
    const walked = gapListings(node.calls);
    expect(walked.map((call) => configOf(call).until)).toEqual(walked.map(() => sig(3)));
    expect(walked).toHaveLength(25);
    expect(configOf(walked.at(-1)).before).toBe(sig(51));
    expect(walked.map((call) => configOf(call).before)).not.toContain(sig(41));
    const outside = new Set(txs.slice(0, 48).map(({ signature }) => signature));
    expect(readSignatures(node.calls).filter((signature) => outside.has(signature))).toEqual(txs.slice(0, 3).map(({ signature }) => signature));
    expect(bodies.at(-1)?.history.complete).toBe(true);
    expect(bodies.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, clock.at));
    expect(states.at(-1)?.gaps).toEqual([]);
    expect(states.at(-1)?.newest).toBe(sig(300));
  });

  it("keeps the call budget per refresh: one listing and at most FEED_TRANSACTIONS_PER_REFRESH reads, a gap listing taking one read", async () => {
    const { node, feed, tick } = await burst(200, 5, {});
    let walked = 0;
    for (let refresh = 0; refresh < 40; refresh++) {
      tick(31);
      const from = node.calls.length;
      const body = await feed.read();
      const calls = node.calls.slice(from);
      const listed = listings(calls).length;
      const reads = readSignatures(calls).length;
      expect(listed + reads).toBeLessThanOrEqual(1 + FEED_TRANSACTIONS_PER_REFRESH);
      expect(reads).toBeLessThanOrEqual(FEED_TRANSACTIONS_PER_REFRESH);
      if (gapListings(calls).length > 0) {
        walked += 1;
        expect(reads).toBeLessThanOrEqual(FEED_TRANSACTIONS_PER_REFRESH - gapListings(calls).length);
      }
      if (body.history.complete) {
        break;
      }
    }
    expect(walked).toBeGreaterThan(0);
  });

  it("keeps history.complete false until the walk ends", async () => {
    const { feed, tick, cache } = await burst(40, 5);
    const { bodies, states } = await drain(feed, tick, cache, 40);
    expect(states[0]?.backlog).toEqual([]);
    expect(states[0]?.gaps).toHaveLength(1);
    expect(bodies[0]?.history.complete).toBe(false);
    bodies.forEach((body, i) => {
      if ((states[i]?.gaps ?? []).length > 0) {
        expect(body.history.complete).toBe(false);
      }
    });
    expect(bodies.at(-1)?.history.complete).toBe(true);
  });

  it("reads new activity before it walks the gap in the same refresh", async () => {
    const txs = chainOf(42);
    const { node, feed, tick } = rig({ limits: SMALL });
    node.add(...txs.slice(0, 5));
    await feed.read();
    node.add(...txs.slice(5, 40));
    for (let refresh = 0; refresh < 2; refresh++) {
      tick(31);
      await feed.read();
    }
    expect(gapListings(node.calls)).toEqual([]);
    node.add(...txs.slice(40));
    tick(31);
    const from = node.calls.length;
    await feed.read();
    const calls = node.calls.slice(from).filter(({ method }) => method === "getTransaction" || method === "getSignaturesForAddress");
    const steps = calls.map((call) => (call.method === "getTransaction" ? (call.params[0] as string) : configOf(call).before !== undefined ? "gap" : "newer"));
    expect(steps).toEqual(["newer", sig(41), sig(42), "gap", sig(21), sig(22)]);
  });

  it("orders events of one slot across the gap's edges", async () => {
    const txs = chainOf(20).map((tx, i) => (i === 10 || i === 5 ? { ...tx, slot: tx.slot - 1 } : tx));
    const { node, feed, tick, cache } = rig({ limits: { signaturePage: 10, transactionsPerRefresh: 20 } });
    node.add(...txs.slice(0, 5));
    await feed.read();
    node.add(...txs.slice(5));
    const { bodies } = await drain(feed, tick, cache, 20);
    const order = [...new Set(bodies.at(-1)?.events.map(({ signature }) => signature))];
    expect(order).toEqual([...txs].reverse().map(({ signature }) => signature));
  });
});

describe("fewer new signatures than a page", () => {
  it("lists once, opens no walk and moves the cursor at once", async () => {
    const { node, feed, tick, cache, clock, txs } = await burst(14, 5);
    const from = node.calls.length;
    tick(31);
    const body = await feed.read();
    const calls = node.calls.slice(from);
    expect(listings(calls).map((call) => [configOf(call).until, configOf(call).before])).toEqual([[sig(5), undefined]]);
    expect(readSignatures(calls)).toEqual(txs.slice(5, 10).map(({ signature }) => signature));
    const state = stored(cache);
    expect(state.newest).toBe(sig(14));
    expect(state).not.toHaveProperty("gaps");
    expect(state).not.toHaveProperty("top");
    expect(body.history.complete).toBe(true);
    const { bodies } = await drain(feed, tick, cache, 5);
    expect(gapListings(node.calls)).toEqual([]);
    expect(bodies.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, clock.at));
  });
});

describe("state saved by the current version", () => {
  it("loads without gap fields and walks a burst that follows", async () => {
    const txs = chainOf(40);
    const first = rig({ limits: SMALL });
    first.node.add(...txs.slice(0, 5));
    await first.feed.read();
    const saved = stored(first.cache);
    expect(saved).not.toHaveProperty("gaps");
    expect(saved).not.toHaveProperty("top");
    const cold = rig({ limits: SMALL }, first);
    first.node.add(...txs.slice(5));
    const { bodies } = await drain(cold.feed, cold.tick, first.cache, 40);
    expect(bodies.at(-1)?.stats.paid_jobs_7d).toBe(paidIn(txs, first.clock.at));
    expect(new Set(readSignatures(first.node.calls))).toEqual(new Set(txs.map(({ signature }) => signature)));
  });
});
