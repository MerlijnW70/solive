import { type RpcTransport, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_ACCOUNTS_EVERY_SECS, FEED_CALL_TIMEOUT_MS, FEED_REFRESH_BUDGET_MS, FEED_SIGNATURE_PAGE, FEED_TRANSACTIONS_PER_REFRESH, STATE_KEY } from "../src/limits.js";
import { liveFeed } from "../src/http.js";
import { addressOf, claimed, signatureOf, type Tx, WORKER } from "./chain.js";
import { FakeNode } from "./fake-node.js";
import { MemoryCache, NOW, nowSecs, rig } from "./harness.js";

const JOB = addressOf(1);
const claim = (n: number): Tx => ({ signature: signatureOf(n), slot: 2000 + n, blockTime: nowSecs(-7200 + n), events: [claimed(JOB, WORKER, 0n)] });
const range = (from: number, to: number): Tx[] => Array.from({ length: to - from + 1 }, (_, i) => claim(from + i));

const tooMany = (retryAfter: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "retry-after": retryAfter }), message: "Too Many Requests", statusCode: 429 });

const programListings = (calls: { method: string; params: unknown[] }[]) =>
  calls.filter(({ method, params }) => method === "getSignaturesForAddress" && params[0] === "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reads", () => {
  it("names the call budget", () => {
    expect([FEED_SIGNATURE_PAGE, FEED_TRANSACTIONS_PER_REFRESH, FEED_ACCOUNTS_EVERY_SECS, FEED_CALL_TIMEOUT_MS, FEED_REFRESH_BUDGET_MS]).toEqual([100, 20, 300, 2500, 8000]);
  });

  it("lists new signatures with until set to the newest one seen, across refreshes and instances", async () => {
    const first = rig();
    first.node.add(...range(1, 3));
    await first.feed.read();
    const [opening] = programListings(first.node.calls);
    expect(opening?.params[1]).toMatchObject({ limit: FEED_SIGNATURE_PAGE });
    expect(opening?.params[1]).not.toHaveProperty("until");
    first.node.add(...range(4, 5));
    first.tick(31);
    const body = await first.feed.read();
    expect(programListings(first.node.calls)[1]?.params[1]).toMatchObject({ until: signatureOf(3) });
    expect(body.events.map(({ signature }) => signature)).toEqual([5, 4, 3, 2, 1].map(signatureOf));
    const cold = rig({}, first);
    cold.tick(31);
    await cold.feed.read();
    expect(programListings(first.node.calls)[2]?.params[1]).toMatchObject({ until: signatureOf(5) });
  });

  it("reads at most FEED_TRANSACTIONS_PER_REFRESH transactions per refresh and carries the rest, oldest first", async () => {
    const { node, feed, tick } = rig();
    node.add(...range(1, 45));
    const first = await feed.read();
    expect(node.count("getTransaction")).toBe(FEED_TRANSACTIONS_PER_REFRESH);
    expect(first.events.map(({ signature }) => signature)).toEqual(range(1, 20).reverse().map(({ signature }) => signature));
    tick(31);
    await feed.read();
    expect(node.count("getTransaction")).toBe(2 * FEED_TRANSACTIONS_PER_REFRESH);
    tick(31);
    const third = await feed.read();
    expect(node.count("getTransaction")).toBe(45);
    expect(third.events[0]?.signature).toBe(signatureOf(45));
    expect(new Set(node.calls.filter(({ method }) => method === "getTransaction").map(({ params }) => params[0])).size).toBe(45);
  });

  it("serves the stored snapshot with stale_since on a 429 and waits retry-after before the next read", async () => {
    const warm = rig();
    warm.node.add(...range(1, 2));
    const good = await warm.feed.read();
    expect(good.stale).toBe(false);
    warm.node.fail = (call) => (call.method === "getSignaturesForAddress" ? tooMany("10") : undefined);
    warm.tick(31);
    const failedAt = new Date(warm.clock.at).toISOString();
    const stale = await warm.feed.read();
    expect(stale).toMatchObject({ stale: true, stale_since: failedAt });
    expect(stale.events).toEqual(good.events);
    expect(warm.logs.at(-1)).toContain('"reason":"RateLimited"');
    const asked = warm.node.calls.length;
    const cold = rig({}, warm);
    cold.tick(5);
    const waiting = await cold.feed.read();
    expect(warm.node.calls.length).toBe(asked);
    expect(waiting).toMatchObject({ stale: true, stale_since: failedAt });
    warm.node.fail = null;
    cold.tick(6);
    const back = await cold.feed.read();
    expect(warm.node.calls.length).toBeGreaterThan(asked);
    expect(back).toMatchObject({ stale: false, stale_since: null });
  });

  it("keeps the transactions read before a 429 and carries the rest past retry-after", async () => {
    const { node, feed, tick } = rig();
    node.add(...range(1, 5));
    let reads = 0;
    node.fail = (call) => (call.method === "getTransaction" && ++reads === 3 ? tooMany("7") : undefined);
    const cut = await feed.read();
    expect(cut.stale).toBe(true);
    expect(cut.events.map(({ signature }) => signature)).toEqual([2, 1].map(signatureOf));
    tick(31);
    const healed = await feed.read();
    expect(healed.stale).toBe(false);
    expect(healed.events.map(({ signature }) => signature)).toEqual([5, 4, 3, 2, 1].map(signatureOf));
    expect(node.count("getTransaction")).toBe(6);
  });

  it("goes stale when a call runs past its timeout, keeping the last good events", async () => {
    const { node, feed, tick, logs } = rig({ limits: { callTimeoutMs: 30 } });
    node.add(claim(1));
    await feed.read();
    node.add(claim(2));
    node.hang = (call) => call.method === "getTransaction";
    tick(31);
    const body = await feed.read();
    expect(body.stale).toBe(true);
    expect(body.events.map(({ signature }) => signature)).toEqual([signatureOf(1)]);
    expect(logs.at(-1)).toContain('"reason":"ReadTimedOut"');
    node.hang = null;
    tick(31);
    const back = await feed.read();
    expect(back.stale).toBe(false);
    expect(back.events.map(({ signature }) => signature)).toEqual([2, 1].map(signatureOf));
  });

  it("stops issuing calls at the refresh deadline: 20 pending, a 100 ms budget, 40 ms per call", async () => {
    const node = new FakeNode();
    node.add(...range(1, 20));
    const slow = (async (config: Parameters<RpcTransport>[0]) => {
      const answer = await node.transport(config);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return answer;
    }) as RpcTransport;
    const { feed, logs } = rig({ transport: slow, limits: { refreshBudgetMs: 100, callTimeoutMs: 1000 } });
    const body = await feed.read();
    const atEnd = node.calls.length;
    expect(body.stale).toBe(true);
    expect(logs.at(-1)).toContain('"reason":"ReadTimedOut"');
    expect(atEnd).toBeGreaterThan(0);
    expect(atEnd).toBeLessThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(node.calls.length).toBe(atEnd);
  });

  it("keeps a transaction the node did not serve pending and reads it again, without holding up the rest", async () => {
    const { node, feed, tick } = rig();
    node.add(...range(1, 3));
    const held = node.transactions.get(signatureOf(2));
    node.transactions.delete(signatureOf(2));
    const cut = await feed.read();
    expect(cut.stale).toBe(false);
    expect(cut.events.map(({ signature }) => signature)).toEqual([3, 1].map(signatureOf));
    node.transactions.set(signatureOf(2), held);
    tick(31);
    const healed = await feed.read();
    expect(healed.events.map(({ signature }) => signature)).toEqual([3, 2, 1].map(signatureOf));
    tick(31);
    const reads = node.count("getTransaction");
    await feed.read();
    expect(node.count("getTransaction")).toBe(reads);
  });

  it("writes the Runtime Cache only when the state changed", async () => {
    const { node, cache, feed, tick } = rig();
    node.add(claim(1));
    await feed.read();
    expect(cache.sets).toBe(1);
    expect(typeof cache.values.get(STATE_KEY)).toBe("string");
    tick(31);
    await feed.read();
    tick(31);
    await feed.read();
    expect(cache.sets).toBe(1);
    node.add(claim(2));
    tick(31);
    await feed.read();
    expect(cache.sets).toBe(2);
    tick(1);
    await feed.read();
    expect(cache.sets).toBe(2);
  });

  it("keeps an in-memory copy when the Runtime Cache fails", async () => {
    const { node, cache, feed, tick } = rig();
    cache.broken = true;
    node.add(claim(1));
    const first = await feed.read();
    expect(first.events).toHaveLength(1);
    node.add(claim(2));
    tick(31);
    const second = await feed.read();
    expect(programListings(node.calls)[1]?.params[1]).toMatchObject({ until: signatureOf(1) });
    expect(second.events.map(({ signature }) => signature)).toEqual([2, 1].map(signatureOf));
  });

  it("refreshes at most once per FEED_MAX_AGE_SECS on one instance and shares one read between concurrent callers", async () => {
    const { node, feed, tick } = rig();
    node.add(claim(1));
    await Promise.all([feed.read(), feed.read(), feed.read()]);
    expect(programListings(node.calls)).toHaveLength(1);
    tick(29);
    await feed.read();
    expect(programListings(node.calls)).toHaveLength(1);
    tick(1);
    await feed.read();
    expect(programListings(node.calls)).toHaveLength(2);
  });

  it("reads open jobs and service lights at most every FEED_ACCOUNTS_EVERY_SECS", async () => {
    const { node, feed, tick } = rig();
    await feed.read();
    expect(node.count("getProgramAccounts")).toBe(1);
    tick(FEED_ACCOUNTS_EVERY_SECS - 30);
    await feed.read();
    expect(programListings(node.calls)).toHaveLength(2);
    expect(node.count("getProgramAccounts")).toBe(1);
    tick(30);
    await feed.read();
    expect(node.count("getProgramAccounts")).toBe(2);
  });
});

describe("secrets", () => {
  const SECRET = "k3y-SECRET-9f1";
  const env = { FEED_RPC_URL: "https://" + `rpc.example.invalid/v2/${SECRET}?api-key=${SECRET}` };

  it("never echoes FEED_RPC_URL in a response or a log line when the node fails", async () => {
    const logs: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      throw new TypeError(`fetch failed for ${String(url)}`);
    });
    const feed = liveFeed({ env, cache: () => new MemoryCache(), probe: async () => 405, now: () => NOW, log: (line) => logs.push(line) });
    const body = await feed.read();
    expect(body.stale).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain("rpc.example.invalid");
  });

  it("honours a 429 from the real HTTP transport without retrying it", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: 429, message: "Too many requests for a specific RPC call" } }), {
        status: 429,
        headers: { "retry-after": "10", "content-type": "application/json" },
      });
    });
    const logs: string[] = [];
    const feed = liveFeed({ env, cache: () => new MemoryCache(), probe: async () => 405, now: () => NOW, log: (line) => logs.push(line) });
    const body = await feed.read();
    expect(asked).toBe(1);
    expect(body).toMatchObject({ stale: true, stale_since: new Date(NOW).toISOString() });
    expect(logs.join("\n")).toContain('"reason":"RateLimited"');
    expect(JSON.stringify(body) + logs.join("\n")).not.toContain(SECRET);
  });
});
