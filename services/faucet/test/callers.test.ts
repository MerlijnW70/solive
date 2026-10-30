import { generateKeyPairSigner, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { drip, REASONS } from "../src/drip.js";
import { CALLER_DRIPS, DRIP_WINDOW_SECS, FLOOR_LAMPORTS } from "../src/limits.js";
import { callerOf } from "../src/request.js";
import { harness, newFaucet, post, type Faucet } from "./fake-node.js";

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
});
