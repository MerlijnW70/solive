import { generateKeyPairSigner, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { drip, REASONS } from "../src/drip.js";
import { DAILY_DRIPS, DRIP_WINDOW_SECS, MAX_SIGNATURES_CHECKED } from "../src/limits.js";
import { harness, newFaucet, post, START_MS, type Faucet, type Harness, type Listed } from "./fake-node.js";

const SEND_METHODS = ["getLatestBlockhash", "sendTransaction"];
const nowSecs = Math.floor(START_MS / 1000);
let faucet: Faucet;
let recipient: Address;

beforeAll(async () => {
  faucet = await newFaucet();
  recipient = (await generateKeyPairSigner()).address;
});

const entry = (index: number, age: number, err?: unknown): Listed => ({
  signature: `history-${index}`,
  blockTime: nowSecs - age,
  ...(err === undefined ? {} : { err }),
});

function history(h: Harness, entries: Listed[]): void {
  h.node.listed.set(faucet.address, entries);
}

function recent(count: number, firstAge = 100): Listed[] {
  return Array.from({ length: count }, (_, index) => entry(index, firstAge + index * 60));
}

const faucetReads = (h: Harness) =>
  h.node.calls.filter((call) => call.method === "getSignaturesForAddress" && call.params[0] === faucet.address);

describe("the daily cap for the whole faucet", () => {
  it("pins the cap at 20", () => {
    expect(DAILY_DRIPS).toBe(20);
  });

  it("answers 429 with retry-after from the oldest counted transaction and sends nothing", async () => {
    const h = harness(faucet);
    const entries = recent(DAILY_DRIPS);
    history(h, entries);
    const oldestAge = nowSecs - Number(entries[DAILY_DRIPS - 1]?.blockTime);
    const response = await drip(post(recipient), h.deps);
    const wait = DRIP_WINDOW_SECS - oldestAge;
    expect(response).toEqual({
      status: 429,
      body: { error: REASONS.daily, retry_after: wait },
      headers: { "retry-after": String(wait) },
    });
    expect(h.node.methods().filter((m) => SEND_METHODS.includes(m))).toEqual([]);
    expect(h.node.sent).toEqual([]);
  });

  it("names another way to get devnet SOL in the reason", () => {
    expect(REASONS.daily).toContain("daily limit");
    expect(REASONS.daily).toContain("https://faucet.solana.com");
  });

  it("sends when one transaction under the cap is in the window", async () => {
    const h = harness(faucet);
    history(h, recent(DAILY_DRIPS - 1));
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(200);
    expect(h.node.sent).toHaveLength(1);
  });

  it("does not count transactions older than the window", async () => {
    const h = harness(faucet);
    const entries = [...recent(DAILY_DRIPS - 1), entry(900, DRIP_WINDOW_SECS), entry(901, DRIP_WINDOW_SECS + 60), entry(902, DRIP_WINDOW_SECS + 120)];
    history(h, entries);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("does not count a transaction that failed", async () => {
    const h = harness(faucet);
    const entries = recent(DAILY_DRIPS);
    entries[3] = entry(3, 100 + 3 * 60, { InstructionError: [0, "Custom"] });
    history(h, entries);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("counts every transaction on the faucet, refills included", async () => {
    const h = harness(faucet);
    history(h, recent(DAILY_DRIPS));
    expect((await drip(post(recipient), h.deps)).status).toBe(429);
  });

  it("counts a transaction without a block time as new", async () => {
    const h = harness(faucet);
    const entries = recent(DAILY_DRIPS);
    entries[0] = { signature: "history-0", blockTime: null };
    history(h, entries);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
  });

  it("pages past the first page to count the window", async () => {
    const h = harness(faucet);
    const failed = Array.from({ length: 100 }, (_, index) => entry(index, 10 + index, { Custom: 1 }));
    const real = Array.from({ length: DAILY_DRIPS }, (_, index) => entry(1000 + index, 1000 + index * 60));
    history(h, [...failed, ...real]);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
    expect(faucetReads(h)).toHaveLength(2);
  });

  it("refuses a history too long to page through and reads no more than the existing limit", async () => {
    const h = harness(faucet);
    const failed = Array.from({ length: MAX_SIGNATURES_CHECKED + 150 }, (_, index) => entry(index, 10 + index, { Custom: 1 }));
    history(h, failed);
    const response = await drip(post(recipient), h.deps);
    expect(response).toEqual({
      status: 429,
      body: { error: REASONS.daily, retry_after: DRIP_WINDOW_SECS },
      headers: { "retry-after": String(DRIP_WINDOW_SECS) },
    });
    expect(h.node.sent).toEqual([]);
    expect(faucetReads(h)).toHaveLength(MAX_SIGNATURES_CHECKED / 100 + 1);
  });

  it("keeps the 503 when the node fails on the history", async () => {
    const h = harness(faucet);
    h.node.failingHistory.add(faucet.address);
    const response = await drip(post(recipient), h.deps);
    expect(response).toEqual({ status: 503, body: { error: REASONS.node } });
    expect(h.node.sent).toEqual([]);
  });

  it("reads no history for a recipient that is refused", async () => {
    const funded = harness(faucet);
    funded.node.balances.set(recipient, 10_000_000_000n);
    history(funded, recent(DAILY_DRIPS));
    expect((await drip(post(recipient), funded.deps)).body).toMatchObject({ error: REASONS.funded });
    expect(faucetReads(funded)).toEqual([]);

    const earlier = harness(faucet);
    earlier.node.listed.set(recipient, [entry(1, 500)]);
    earlier.node.landed.set("history-1", { feePayer: faucet.address });
    history(earlier, recent(DAILY_DRIPS));
    expect((await drip(post(recipient), earlier.deps)).body).toMatchObject({ error: REASONS.recent });
    expect(faucetReads(earlier)).toEqual([]);
  });

  it("reads the history once when the faucet is under the cap", async () => {
    const h = harness(faucet);
    history(h, recent(3));
    await drip(post(recipient), h.deps);
    expect(faucetReads(h)).toHaveLength(1);
  });
});

describe("the caller mark and agent in the log line", () => {
  const request = (ip: string, agent?: string) => ({
    ...post(recipient, ip),
    headers: { "x-forwarded-for": ip, ...(agent === undefined ? {} : { "user-agent": agent }) },
  });

  const lineOf = async (h: Harness, ip: string, agent?: string) => {
    h.lines.length = 0;
    await drip(request(ip, agent), h.deps);
    return JSON.parse(h.lines[0] ?? "{}") as { status: number; caller?: string; agent?: string };
  };

  it("holds a 16 character hex mark and the agent, never the raw address", async () => {
    const h = harness(faucet);
    const line = await lineOf(h, "203.0.113.9", "solive-test/1.0");
    expect(line.caller).toMatch(/^[0-9a-f]{16}$/);
    expect(line.agent).toBe("solive-test/1.0");
    expect(h.lines.join("\n")).not.toContain("203.0.113.9");
  });

  it("changes with the caller", async () => {
    const h = harness(faucet);
    const first = await lineOf(h, "203.0.113.9");
    const second = await lineOf(h, "203.0.113.10");
    expect(first.caller).not.toBe(second.caller);
  });

  it("stays the same for one caller within a day", async () => {
    const h = harness(faucet);
    const first = await lineOf(h, "203.0.113.9");
    h.clock.at += 60_000;
    const second = await lineOf(h, "203.0.113.9");
    expect(first.caller).toBe(second.caller);
  });

  it("changes with the UTC day", async () => {
    const h = harness(faucet);
    const first = await lineOf(h, "203.0.113.9");
    h.clock.at += 24 * 3600 * 1000;
    const second = await lineOf(h, "203.0.113.9");
    expect(first.caller).not.toBe(second.caller);
  });

  it("changes with the faucet secret", async () => {
    const other = await newFaucet();
    const first = await lineOf(harness(faucet), "203.0.113.9");
    const second = await lineOf(harness(faucet, { secret: other.secret }), "203.0.113.9");
    expect(first.caller).not.toBe(second.caller);
  });

  it("leaves the mark out when no secret is set", async () => {
    const h = harness(faucet, { secret: undefined });
    const line = await lineOf(h, "203.0.113.9", "agent");
    expect(line).toEqual({ status: 503, agent: "agent" });
  });

  it("cuts the agent to 80 characters", async () => {
    const h = harness(faucet);
    const line = await lineOf(h, "203.0.113.9", "a".repeat(200));
    expect(line.agent).toBe("a".repeat(80));
  });

  it("keeps control characters out of the log", async () => {
    const h = harness(faucet);
    const line = await lineOf(h, "203.0.113.9", "bad\r\nagent\u0000\u001b[31m\u0085\u2028x");
    expect(line.agent).toBe("badagent[31mx");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  it("leaves the agent out without a user-agent header", async () => {
    const h = harness(faucet);
    const line = await lineOf(h, "203.0.113.9");
    expect(line).not.toHaveProperty("agent");
  });
});
