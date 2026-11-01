import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { pruned } from "../src/apply.js";
import { KEPT_PAID, STATE_KEY } from "../src/limits.js";
import { emptyState, type Paid } from "../src/shapes.js";
import { addressOf, attested, claimed, createAccounts, createCall, created, CUSTOM_HASH, JUDGE, OWNER, released, type Tx, WORKER } from "./chain.js";
import { at, chainOf, stored, untilComplete } from "./history-chain.js";
import { NOW, rig } from "./harness.js";

const JOB = addressOf(90);
const NET = 2_500_000n;

function probe(total: number, releaseAt: number): Tx[] {
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    if (n === 1) {
      return { ...at(n, total, [created(JOB, OWNER, NET, DEVNET_TEST_MINT)], [DEVNET_TEST_MINT]), calls: [{ data: createCall(JUDGE, CUSTOM_HASH, NET), accounts: createAccounts(OWNER, JOB) }] };
    }
    if (n === releaseAt) {
      return at(n, total, [released(JOB, WORKER, JUDGE), attested(JOB, OWNER, WORKER, JUDGE, NET)], [DEVNET_TEST_MINT, NATIVE_MINT]);
    }
    return at(n, total, [claimed(addressOf(91), WORKER, 0n)]);
  });
}

describe("a release read before its escrow", () => {
  it.each([
    ["the opening page", 15, 15],
    ["an older page than the escrow's", 25, 12],
    ["the escrow's own backfill page", 25, 3],
  ])("counts once when the release sits in %s and its transaction holds two mints", async (_, total, releaseAt) => {
    const { node, feed, tick } = rig({ limits: { signaturePage: 10, transactionsPerRefresh: 20 } });
    node.add(...probe(total, releaseAt));
    const seen = await untilComplete(feed, tick, 20);
    expect(seen.at(-1)?.history.complete).toBe(true);
    expect(seen.at(-1)?.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 1, paid_7d: [{ token: "TEST", amount: "2.5" }] });
  });
});

describe("history after the backfill", () => {
  it("stays complete while new activity waits, more than one refresh reads or the node does not serve yet", async () => {
    const txs = chainOf(260);
    const { node, feed, tick, cache } = rig();
    node.add(...txs.slice(0, 15));
    expect((await feed.read()).history.complete).toBe(true);
    node.add(...txs.slice(15, 45));
    node.transactions.delete(txs[15]?.signature ?? "");
    tick(31);
    const body = await feed.read();
    expect(stored(cache).pending.length).toBeGreaterThan(0);
    expect(body.history.complete).toBe(true);
  });
});

describe("a transaction read twice", () => {
  it("adds its events and its paid job once", async () => {
    const txs = chainOf(12);
    const first = rig();
    first.node.add(...txs);
    const once = await first.feed.read();
    const state = stored(first.cache);
    state.pending = txs.map(({ signature, slot, blockTime }) => ({ signature, slot, blockTime }));
    first.cache.values.set(STATE_KEY, JSON.stringify(state));
    const cold = rig({}, first);
    cold.tick(31);
    const twice = await cold.feed.read();
    expect(first.node.count("getTransaction")).toBe(2 * txs.length);
    expect(twice.events).toEqual(once.events);
    expect(twice.stats).toEqual(once.stats);
  });
});

describe("the paid cap", () => {
  it("keeps the newest KEPT_PAID entries when older ones were pushed last", () => {
    const state = emptyState();
    const entry = (minutesAgo: number, n: number): Paid => ({ at: new Date(NOW - minutesAgo * 60_000).toISOString(), slot: 1_000_000 - minutesAgo, intent: addressOf(n % 200), payee: WORKER, token: "SOL", raw: "1", decimals: 9, house: false });
    const newest = Array.from({ length: KEPT_PAID }, (_, i) => entry(i + 1, i));
    const older = Array.from({ length: 10 }, (_, i) => entry(5 * 24 * 60 + i, i));
    state.paid.push(...newest, ...older);
    pruned(state, NOW);
    expect(state.paid).toHaveLength(KEPT_PAID);
    expect(new Set(state.paid.map(({ at: when }) => when))).toEqual(new Set(newest.map(({ at: when }) => when)));
  });
});
