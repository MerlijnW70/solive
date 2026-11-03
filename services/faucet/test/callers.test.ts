import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { drip, REASONS } from "../src/drip.js";
import {
  CALLER_CHECKS,
  CALLER_DRIPS,
  CHECK_WINDOW_SECS,
  DAILY_DRIPS,
  DAILY_PAGE,
  DRIP_WINDOW_SECS,
  FLOOR_LAMPORTS,
  MAX_HISTORY_PAGES,
  RECIPIENT_MEMORY_SECS,
} from "../src/limits.js";
import { callerOf } from "../src/request.js";
import { harness, newFaucet, post, START_MS, type Faucet } from "./fake-node.js";

let faucet: Faucet;
let addresses: Address[];

beforeAll(async () => {
  faucet = await newFaucet();
  addresses = await Promise.all(Array.from({ length: 8 }, async () => (await generateKeyPairSigner()).address));
});

const at = (i: number): Address => addresses[i] as Address;

describe("caller ip", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(callerOf({ "x-forwarded-for": " 198.51.100.4 , 10.0.0.1", "x-real-ip": "10.9.9.9" })).toBe("198.51.100.4");
    expect(callerOf({ "x-forwarded-for": ["198.51.100.5, 10.0.0.1", "10.0.0.2"] })).toBe("198.51.100.5");
  });

  it("falls back to x-real-ip, then the socket address", () => {
    expect(callerOf({ "x-forwarded-for": "", "x-real-ip": "198.51.100.6" })).toBe("198.51.100.6");
    expect(callerOf({ "x-real-ip": "198.51.100.6" })).toBe("198.51.100.6");
    expect(callerOf({}, "198.51.100.8")).toBe("198.51.100.8");
    expect(callerOf({})).toBe("unknown");
  });
});

describe("429 the caller is over its limit", () => {
  it("allows three drips per ip per window inside one instance", async () => {
    expect(CALLER_DRIPS).toBe(3);
    const h = harness(faucet);
    for (let i = 0; i < CALLER_DRIPS; i += 1) {
      h.clock.at += 1000;
      expect((await drip(post(at(i), "198.51.100.1, 10.0.0.1"), h.deps)).status).toBe(200);
    }
    const first = h.clock.at - 3000 + 1000;
    const refused = await drip(post(at(3), "198.51.100.1"), h.deps);
    const retry = Math.ceil((first + DRIP_WINDOW_SECS * 1000 - h.clock.at) / 1000);
    expect(refused).toEqual({ status: 429, body: { error: REASONS.caller, retry_after: retry }, headers: { "retry-after": String(retry) } });
    expect(h.node.sent).toHaveLength(CALLER_DRIPS);
    expect((await drip(post(at(4), "198.51.100.2"), h.deps)).status).toBe(200);
  });

  it("counts x-real-ip when x-forwarded-for is absent", async () => {
    const h = harness(faucet);
    const request = (i: number) => ({ method: "POST", headers: { "x-real-ip": "198.51.100.3" }, body: JSON.stringify({ address: at(i) }) });
    for (let i = 0; i < CALLER_DRIPS; i += 1) expect((await drip(request(i), h.deps)).status).toBe(200);
    expect((await drip(request(3), h.deps)).status).toBe(429);
  });

  it("allows the ip again once the window passes", async () => {
    const h = harness(faucet);
    for (let i = 0; i < CALLER_DRIPS; i += 1) await drip(post(at(i)), h.deps);
    expect((await drip(post(at(3)), h.deps)).status).toBe(429);
    h.clock.at += DRIP_WINDOW_SECS * 1000;
    expect((await drip(post(at(3)), h.deps)).status).toBe(200);
  });

  it("does not count a request that sent nothing", async () => {
    const h = harness(faucet);
    h.node.balances.set(faucet.address, FLOOR_LAMPORTS - 1n);
    for (let i = 0; i < CALLER_DRIPS + 2; i += 1) expect((await drip(post(at(i)), h.deps)).status).toBe(503);
    h.node.balances.set(faucet.address, FLOOR_LAMPORTS * 10n);
    expect((await drip(post(at(0)), h.deps)).status).toBe(200);
  });

  it("counts a send that did not confirm", async () => {
    const h = harness(faucet);
    h.node.statuses = () => null;
    for (let i = 0; i < CALLER_DRIPS; i += 1) expect((await drip(post(at(i)), h.deps)).status).toBe(503);
    expect((await drip(post(at(3)), h.deps)).status).toBe(429);
  });

  it("refuses concurrent requests past the limit", async () => {
    const h = harness(faucet);
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => drip(post(at(i)), h.deps)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(CALLER_DRIPS);
    expect(answers.filter((a) => a.status === 429)).toHaveLength(6 - CALLER_DRIPS);
  });

  it("sends once when two callers ask for the same address at the same time", async () => {
    const h = harness(faucet);
    const answers = await Promise.all([drip(post(at(0), "198.51.100.11"), h.deps), drip(post(at(0), "198.51.100.12"), h.deps)]);
    expect(answers.map((a) => a.status)).toEqual([200, 429]);
    expect(answers[1]?.body).toEqual({ error: REASONS.pending, retry_after: 60 });
    expect(h.node.sent).toHaveLength(1);
    for (let i = 1; i < CALLER_DRIPS + 1; i += 1) expect((await drip(post(at(i), "198.51.100.12"), h.deps)).status).toBe(200);
  });

  it("keeps the limit in memory of one instance only", () => {
    const one = new CallerLimit();
    const other = new CallerLimit();
    for (let i = 0; i < CALLER_DRIPS; i += 1) expect(one.reserve("ip", i).ok).toBe(true);
    expect(one.reserve("ip", 5).ok).toBe(false);
    expect(other.reserve("ip", 5).ok).toBe(true);
  });

  it("releases a reservation once and forgets expired callers", () => {
    const limit = new CallerLimit(1, 10);
    const first = limit.reserve("ip", 0);
    if (!first.ok) throw new Error("expected a reservation");
    first.release();
    first.release();
    const second = limit.reserve("ip", 1);
    expect(second.ok).toBe(true);
    expect(limit.reserve("ip", 2)).toEqual({ ok: false, retryAfter: 10 });
    limit.forget(20000);
    expect(limit.reserve("ip", 20000).ok).toBe(true);
  });

  it("counts a send whose outcome the faucet cannot tell, and not one the node refused", async () => {
    const lost = harness(faucet);
    lost.node.sendError = "lost";
    lost.node.statuses = () => null;
    for (let i = 0; i < CALLER_DRIPS; i += 1) expect((await drip(post(at(i)), lost.deps)).status).toBe(503);
    expect((await drip(post(at(3)), lost.deps)).body).toMatchObject({ error: REASONS.caller });
    const refused = harness(faucet);
    refused.node.sendError = "preflight";
    for (let i = 0; i < CALLER_DRIPS + 1; i += 1) expect((await drip(post(at(i)), refused.deps)).status).toBe(503);
  });

  it("says per instance in the refusals and the readme that name a network limit", () => {
    expect(REASONS.caller).toContain("this faucet instance");
    expect(REASONS.checks).toContain("this faucet instance");
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).toContain("## Per network, per instance");
    expect(readme).toContain(`gets at most ${CALLER_DRIPS} drips in 24 hours`);
    expect(CHECK_WINDOW_SECS).toBe(3600);
    expect(readme).toContain(`at most ${CALLER_CHECKS} requests that reach the node in an hour`);
    expect(readme).toContain(`kept for ${RECIPIENT_MEMORY_SECS / 60} minutes`);
    expect(readme).toContain(`reads at most ${MAX_HISTORY_PAGES} pages of ${DAILY_PAGE} entries and no transactions`);
    expect(readme).toContain(`each instance also stops at ${DAILY_DRIPS} of its own sends`);
    expect(readme).toContain(`more than ${MAX_HISTORY_PAGES * DAILY_PAGE} entries in the window`);
  });
});

describe("429 the caller asked the node too often", () => {
  const fresh = async (count: number) => Promise.all(Array.from({ length: count }, async () => (await generateKeyPairSigner()).address));

  it("stops repeated refused requests from one caller reaching the node after its budget", async () => {
    expect(CALLER_CHECKS).toBeGreaterThan(CALLER_DRIPS);
    const h = harness(faucet);
    const funded = await fresh(CALLER_CHECKS + 1);
    for (const address of funded) h.node.balances.set(address, 10_000_000_000n);
    for (const address of funded.slice(0, CALLER_CHECKS)) {
      expect((await drip(post(address, "198.51.100.21"), h.deps)).body).toMatchObject({ error: REASONS.funded });
    }
    const calls = h.node.calls.length;
    const refused = await drip(post(funded[CALLER_CHECKS], "198.51.100.21"), h.deps);
    expect(refused).toEqual({
      status: 429,
      body: { error: REASONS.checks, retry_after: CHECK_WINDOW_SECS },
      headers: { "retry-after": String(CHECK_WINDOW_SECS) },
    });
    expect(h.node.calls).toHaveLength(calls);
    expect((await drip(post(at(0), "198.51.100.22"), h.deps)).status).toBe(200);
    h.clock.at += CHECK_WINDOW_SECS * 1000;
    expect((await drip(post(at(1), "198.51.100.21"), h.deps)).status).toBe(200);
  });

  it("keeps the drip quota for an honest caller after its refusals", async () => {
    const h = harness(faucet);
    const funded = await fresh(CALLER_CHECKS - CALLER_DRIPS);
    for (const address of funded) {
      h.node.balances.set(address, 10_000_000_000n);
      expect((await drip(post(address), h.deps)).status).toBe(429);
    }
    for (let i = 0; i < CALLER_DRIPS; i += 1) expect((await drip(post(at(i)), h.deps)).status).toBe(200);
  });

  it("does not repeat a recipient history read within a short time", async () => {
    const h = harness(faucet);
    const nowSecs = Math.floor(START_MS / 1000);
    h.node.listed.set(at(5), [{ signature: "earlier", blockTime: nowSecs - 3600 }]);
    h.node.landed.set("earlier", { feePayer: faucet.address });
    const reads = () => h.node.calls.filter((call) => call.method === "getSignaturesForAddress" && call.params[0] === at(5)).length;
    expect((await drip(post(at(5), "198.51.100.31"), h.deps)).body).toEqual({ error: REASONS.recent, retry_after: DRIP_WINDOW_SECS - 3600 });
    expect(reads()).toBe(1);
    h.clock.at += 60_000;
    const calls = h.node.calls.length;
    expect((await drip(post(at(5), "198.51.100.32"), h.deps)).body).toEqual({ error: REASONS.recent, retry_after: DRIP_WINDOW_SECS - 3660 });
    expect(h.node.calls).toHaveLength(calls);
    h.clock.at += RECIPIENT_MEMORY_SECS * 1000;
    await drip(post(at(5), "198.51.100.33"), h.deps);
    expect(reads()).toBe(2);
  });

  it("remembers a drip it just sent without reading the node again", async () => {
    const h = harness(faucet);
    expect((await drip(post(at(6), "198.51.100.41"), h.deps)).status).toBe(200);
    const calls = h.node.calls.length;
    expect((await drip(post(at(6), "198.51.100.42"), h.deps)).body).toEqual({ error: REASONS.recent, retry_after: DRIP_WINDOW_SECS });
    expect(h.node.calls).toHaveLength(calls);
  });

  it("reserves the sends of an instance within the window and gives back a released one", () => {
    const limit = new CallerLimit(3, 10, 10, 3600, 2);
    const first = limit.reserveSend(0);
    expect(limit.reserveSend(1000).ok).toBe(true);
    expect(limit.reserveSend(2000)).toEqual({ ok: false, retryAfter: 8 });
    if (!first.ok) throw new Error("expected a send");
    first.release();
    expect(limit.reserveSend(2000).ok).toBe(true);
    expect(limit.reserveSend(3000).ok).toBe(false);
    limit.forget(12000);
    expect(limit.reserveSend(12000).ok).toBe(true);
  });

  it("spends checks within a window and forgets them after it", () => {
    const limit = new CallerLimit(3, 10, 2, 5);
    expect(limit.spend("ip", 0)).toEqual({ ok: true });
    expect(limit.spend("ip", 1000)).toEqual({ ok: true });
    expect(limit.spend("ip", 2000)).toEqual({ ok: false, retryAfter: 3 });
    expect(limit.spend("other", 2000)).toEqual({ ok: true });
    limit.forget(6000);
    expect(limit.spend("ip", 6000)).toEqual({ ok: true });
  });

  it("forgets a remembered recipient after the memory time or its wait", () => {
    const limit = new CallerLimit();
    limit.remember("a", "busy", 1_000_000_000, 0);
    limit.remember("b", "recent", 5000, 0);
    limit.remember("c", "recent", 0, 0);
    expect(limit.recall("a", 1000)).toEqual({ reason: "busy", retryAfter: 999_999 });
    expect(limit.recall("b", 4000)).toEqual({ reason: "recent", retryAfter: 1 });
    expect(limit.recall("b", 5000)).toBeUndefined();
    expect(limit.recall("c", 0)).toBeUndefined();
    expect(limit.recall("a", RECIPIENT_MEMORY_SECS * 1000)).toBeUndefined();
  });
});
