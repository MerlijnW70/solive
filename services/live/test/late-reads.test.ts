import { describe, expect, it } from "vitest";
import { Cancelled } from "@intent-engine/client";
import { FEED_UNREAD_TRIES, STATE_KEY } from "../src/limits.js";
import { guarded, ReadTimedOut } from "../src/rpc.js";
import type { State } from "../src/shapes.js";
import { addressOf, announced, attested, claimed, JUDGE, OWNER, released, signatureOf, type Tx, WORKER } from "./chain.js";
import { type MemoryCache, nowSecs, rig } from "./harness.js";

const JOB = addressOf(1);
const OTHER = addressOf(2);
const at = (n: number, events: Uint8Array[]): Tx => ({ signature: signatureOf(n), slot: 2000 + n, blockTime: nowSecs(-7200 + n), events });
const claim = (n: number): Tx => at(n, [claimed(JOB, WORKER, 0n)]);
const pay = (n: number, intent: typeof JOB): Tx => at(n, [released(intent, WORKER, JUDGE), attested(intent, OWNER, WORKER, JUDGE, 1_000n)]);
const stored = (cache: MemoryCache): State => JSON.parse(String(cache.values.get(STATE_KEY))) as State;

describe("a transaction the node does not serve", () => {
  it("is given up after the cap, so 20 stuck ones do not hold back 5 waiting events", async () => {
    const { node, feed, tick, cache, logs } = rig();
    const stuck = Array.from({ length: 20 }, (_, i) => claim(i + 1));
    const waiting = Array.from({ length: 5 }, (_, i) => claim(i + 21));
    node.add(...stuck, ...waiting);
    for (const { signature } of stuck) {
      node.transactions.delete(signature);
    }
    expect(FEED_UNREAD_TRIES).toBe(10);
    for (let refresh = 1; refresh < FEED_UNREAD_TRIES; refresh++) {
      expect((await feed.read()).events).toEqual([]);
      expect(stored(cache).pending[0]?.tries).toBe(refresh);
      tick(31);
    }
    await feed.read();
    expect(stored(cache).pending.map(({ signature }) => signature)).toEqual(waiting.map(({ signature }) => signature));
    const gaveUp = logs.map((line) => JSON.parse(line) as { refresh?: string; signature?: string }).filter(({ refresh }) => refresh === "gave up");
    expect(gaveUp.map(({ signature }) => signature)).toEqual(stuck.map(({ signature }) => signature));
    tick(31);
    const body = await feed.read();
    expect(body.events.map(({ signature }) => signature)).toEqual([...waiting].reverse().map(({ signature }) => signature));
    expect(stored(cache).pending).toEqual([]);
  });

  it("is kept and applied when it heals on the last read before the cap", async () => {
    const { node, feed, tick, cache } = rig();
    node.add(claim(1));
    const held = node.transactions.get(signatureOf(1));
    node.transactions.delete(signatureOf(1));
    for (let refresh = 1; refresh < FEED_UNREAD_TRIES; refresh++) {
      await feed.read();
      tick(31);
    }
    expect(stored(cache).pending).toHaveLength(1);
    node.transactions.set(signatureOf(1), held);
    const body = await feed.read();
    expect(body.events.map(({ signature }) => signature)).toEqual([signatureOf(1)]);
    expect(stored(cache).pending).toEqual([]);
  });

  it("loads saved state whose pending entries have no tries", async () => {
    const first = rig();
    first.node.add(claim(1));
    first.node.transactions.delete(signatureOf(1));
    await first.feed.read();
    const state = stored(first.cache);
    state.pending = state.pending.map(({ signature, slot, blockTime }) => ({ signature, slot, blockTime }));
    first.cache.values.set(STATE_KEY, JSON.stringify(state));
    const cold = rig({}, first);
    cold.tick(31);
    await cold.feed.read();
    expect(stored(first.cache).pending[0]?.tries).toBe(1);
  });
});

describe("a late read", () => {
  it("does not replace the latest paid job with an older release", async () => {
    const { node, feed, tick } = rig();
    node.add(pay(1, JOB), pay(2, OTHER));
    const held = node.transactions.get(signatureOf(1));
    node.transactions.delete(signatureOf(1));
    expect((await feed.read()).latest_paid_job?.intent).toBe(OTHER);
    node.transactions.set(signatureOf(1), held);
    tick(31);
    const healed = await feed.read();
    expect(healed.events[0]?.signature).toBe(signatureOf(2));
    expect(healed.latest_paid_job?.intent).toBe(OTHER);
  });

  it("does not replace a job's delivery with an older one", async () => {
    const { node, feed, tick, cache } = rig();
    node.add(at(1, [announced(JOB, WORKER, JUDGE)]), at(2, [announced(JOB, WORKER, JUDGE)]));
    const held = node.transactions.get(signatureOf(1));
    node.transactions.delete(signatureOf(1));
    await feed.read();
    node.transactions.set(signatureOf(1), held);
    tick(31);
    await feed.read();
    expect(stored(cache).jobs[JOB]?.delivery?.signature).toBe(signatureOf(2));
  });
});

describe("a cancelled call", () => {
  it("reads as out of time, so a mint read in flight at the deadline does not count as a missing mint", async () => {
    await expect(guarded(() => Promise.reject(new Cancelled("getAccountInfo")))).rejects.toBeInstanceOf(ReadTimedOut);
  });
});
