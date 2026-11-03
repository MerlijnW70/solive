import { generateKeyPairSigner, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { drip, REASONS } from "../src/drip.js";
import { CALLER_CHECKS, DAILY_DRIPS, DAILY_PAGE, DRIP_WINDOW_SECS, MAX_HISTORY_PAGES } from "../src/limits.js";
import { faucetSigner } from "../src/secret.js";
import { dripTag, ownDrip } from "../src/tag.js";
import { BLOCKHASH, harness, listedMemo, newFaucet, post, signedDrips, START_MS, type Faucet, type Harness, type Listed, type Signed } from "./fake-node.js";

const SEND_METHODS = ["getLatestBlockhash", "sendTransaction"];
const nowSecs = Math.floor(START_MS / 1000);
let faucet: Faucet;
let recipient: Address;
let own: Signed[];
let other: Signed[];

beforeAll(async () => {
  faucet = await newFaucet();
  recipient = (await generateKeyPairSigner()).address;
  own = await signedDrips(faucet, DAILY_DRIPS + 10);
  other = await signedDrips(await newFaucet(), DAILY_DRIPS);
});

const entry = (index: number, age: number, err?: unknown): Listed => ({
  signature: own[index]?.signature ?? "",
  memo: own[index]?.memo ?? "",
  blockTime: nowSecs - age,
  ...(err === undefined ? {} : { err }),
});

const foreign = (index: number, age: number, err?: unknown): Listed => ({
  signature: `foreign-${index}`,
  blockTime: nowSecs - age,
  ...(err === undefined ? {} : { err }),
});

const forged = (index: number, age: number): Listed => ({
  signature: other[index % DAILY_DRIPS]?.signature ?? "",
  memo: own[index % DAILY_DRIPS]?.memo ?? "",
  blockTime: nowSecs - age,
});

function history(h: Harness, entries: Listed[]): void {
  h.node.listed.set(faucet.address, entries);
}

function recent(count: number, firstAge = 100): Listed[] {
  return Array.from({ length: count }, (_, index) => entry(index, firstAge + index * 60));
}

const flood = (length: number, age = 10): Listed[] => Array.from({ length }, (_, index) => foreign(index, age));

const faucetReads = (h: Harness) =>
  h.node.calls.filter((call) => call.method === "getSignaturesForAddress" && call.params[0] === faucet.address);

const transactionReads = (h: Harness) => h.node.methods().filter((method) => method === "getTransaction");

describe("the daily cap for the whole faucet", () => {
  it("pins the cap at 20", () => {
    expect(DAILY_DRIPS).toBe(20);
  });

  it("answers 429 with retry-after from the oldest counted drip and sends nothing", async () => {
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

  it("sends when one drip under the cap is in the window", async () => {
    const h = harness(faucet);
    history(h, recent(DAILY_DRIPS - 1));
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(200);
    expect(h.node.sent).toHaveLength(1);
  });

  it("does not count drips older than the window", async () => {
    const h = harness(faucet);
    const entries = [...recent(DAILY_DRIPS - 1), entry(DAILY_DRIPS, DRIP_WINDOW_SECS), entry(DAILY_DRIPS + 1, DRIP_WINDOW_SECS + 60)];
    history(h, entries);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("does not count a drip that failed", async () => {
    const h = harness(faucet);
    const entries = recent(DAILY_DRIPS);
    entries[3] = entry(3, 100 + 3 * 60, { InstructionError: [0, "Custom"] });
    history(h, entries);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
  });

  it("does not count an incoming tiny transfer or a refill paid by another wallet", async () => {
    const h = harness(faucet);
    history(h, [foreign(0, 30), ...recent(DAILY_DRIPS - 1)]);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
    expect(h.node.sent).toHaveLength(1);
  });

  it("does not count a copied drip tag under a signature the faucet did not make", async () => {
    const h = harness(faucet);
    history(h, [forged(0, 30), ...recent(DAILY_DRIPS - 1)]);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
    const all = harness(faucet);
    history(all, Array.from({ length: DAILY_DRIPS * 3 }, (_, index) => forged(index, 30 + index)));
    expect((await drip(post(recipient), all.deps)).status).toBe(200);
    expect(transactionReads(all)).toEqual([]);
  });

  it("still counts the faucet's own drips between foreign transfers", async () => {
    const h = harness(faucet);
    const mixed = recent(DAILY_DRIPS).flatMap((mine, index) => [foreign(index, 100 + index * 60 - 1), forged(index, 100 + index * 60 - 1), mine]);
    history(h, mixed);
    expect((await drip(post(recipient), h.deps)).body).toMatchObject({ error: REASONS.daily });
  });

  it("recognises the drip it sends as its own", async () => {
    const h = harness(faucet);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
    const sent = h.node.sent[0];
    expect(sent?.memo).toBe(dripTag(recipient, BLOCKHASH as never));
    const signer = await faucetSigner(faucet.secret);
    if (signer === undefined || sent?.memo === undefined) throw new Error("expected a signer and a memo");
    expect(await ownDrip(signer, sent.signature, listedMemo(sent.memo))).toBe(true);
    expect(await ownDrip(signer, sent.signature, listedMemo(dripTag(faucet.address, BLOCKHASH as never)))).toBe(false);
    expect(await ownDrip(signer, sent.signature, sent.memo)).toBe(false);
    const next = harness(faucet);
    history(next, [{ signature: sent.signature, memo: listedMemo(sent.memo), blockTime: nowSecs - 5 }, ...recent(DAILY_DRIPS - 1)]);
    expect((await drip(post(recipient), next.deps)).body).toMatchObject({ error: REASONS.daily });
  });

  it("does not answer busy for a flood of foreign entries and reads no transaction for them", async () => {
    const h = harness(faucet);
    history(h, flood(DAILY_PAGE * MAX_HISTORY_PAGES + 50));
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(200);
    expect(transactionReads(h)).toEqual([]);
    expect(faucetReads(h)).toHaveLength(MAX_HISTORY_PAGES);
    expect(h.node.calls.length).toBeLessThanOrEqual(MAX_HISTORY_PAGES + 10);
  });

  it("opens an in-window run of entries followed by one old entry", async () => {
    const h = harness(faucet);
    history(h, [...flood(DAILY_PAGE, 10), entry(0, DRIP_WINDOW_SECS + 10)]);
    expect((await drip(post(recipient), h.deps)).status).toBe(200);
    expect(faucetReads(h)).toHaveLength(2);
  });

  it("counts a drip without a block time as new", async () => {
    const h = harness(faucet);
    const entries = recent(DAILY_DRIPS);
    entries[0] = { ...entry(0, 0), blockTime: null };
    history(h, entries);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
  });

  it("pages past the first page to count the window", async () => {
    const h = harness(faucet);
    history(h, [...flood(DAILY_PAGE, 5), ...recent(DAILY_DRIPS, 1000)]);
    const response = await drip(post(recipient), h.deps);
    expect(response.status).toBe(429);
    expect(faucetReads(h)).toHaveLength(2);
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
    earlier.node.listed.set(recipient, [{ signature: "earlier-1", blockTime: nowSecs - 500 }]);
    earlier.node.landed.set("earlier-1", { feePayer: faucet.address });
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

describe("the daily brake of one instance", () => {
  it("stops a flood that hides earlier drips from opening the cap past this instance's own sends", async () => {
    const h = harness(faucet);
    history(h, [...flood(DAILY_PAGE * MAX_HISTORY_PAGES), ...recent(DAILY_DRIPS, 2000)]);
    const addresses = await Promise.all(Array.from({ length: DAILY_DRIPS + 1 }, async () => (await generateKeyPairSigner()).address));
    for (let i = 0; i < DAILY_DRIPS; i += 1) expect((await drip(post(addresses[i], `198.51.100.${i + 1}`), h.deps)).status).toBe(200);
    const calls = h.node.calls.length;
    const refused = await drip(post(addresses[DAILY_DRIPS], "198.51.100.99"), h.deps);
    expect(refused).toEqual({ status: 429, body: { error: REASONS.instance, retry_after: DRIP_WINDOW_SECS }, headers: { "retry-after": String(DRIP_WINDOW_SECS) } });
    expect(h.node.methods().slice(calls).filter((m) => SEND_METHODS.includes(m))).toEqual([]);
    expect(h.node.sent).toHaveLength(DAILY_DRIPS);
    h.clock.at += DRIP_WINDOW_SECS * 1000;
    expect((await drip(post(addresses[DAILY_DRIPS], "198.51.100.99"), h.deps)).status).toBe(200);
  });

  it("does not spend the instance's sends on a request that sent nothing", async () => {
    const h = harness(faucet);
    h.node.sendError = "preflight";
    const addresses = await Promise.all(Array.from({ length: DAILY_DRIPS + 1 }, async () => (await generateKeyPairSigner()).address));
    for (let i = 0; i < DAILY_DRIPS + 1; i += 1) expect((await drip(post(addresses[i], `198.51.100.${i + 1}`), h.deps)).status).toBe(503);
    h.node.sendError = undefined;
    expect((await drip(post(recipient, "198.51.100.200"), h.deps)).status).toBe(200);
  });

  it("never answers the instance limit for concurrent requests that send nothing, and serves an honest one beside them", async () => {
    const h = harness(faucet);
    const funded = await Promise.all(Array.from({ length: DAILY_DRIPS + 5 }, async () => (await generateKeyPairSigner()).address));
    for (const address of funded) h.node.balances.set(address, 10_000_000_000n);
    const refused = funded.map((address, i) => drip(post(address, `198.51.100.${Math.floor(i / 3) + 1}`), h.deps));
    const honest = drip(post(recipient, "203.0.113.200"), h.deps);
    const answers = await Promise.all([...refused, honest]);
    for (const answer of answers) expect(answer.body).not.toMatchObject({ error: REASONS.instance });
    expect(answers.slice(0, funded.length).every((answer) => answer.status === 429)).toBe(true);
    expect((await honest).status).toBe(200);
    expect(h.node.sent).toHaveLength(1);
  });

  it("keeps serving others while one caller is over its hourly budget", async () => {
    const h = harness(faucet);
    const funded = await Promise.all(Array.from({ length: DAILY_DRIPS + CALLER_CHECKS }, async () => (await generateKeyPairSigner()).address));
    for (const address of funded) h.node.balances.set(address, 10_000_000_000n);
    const answers = [];
    for (const address of funded) answers.push((await drip(post(address, "198.51.100.77"), h.deps)).body);
    expect(answers.filter((body) => "error" in body && body.error === REASONS.checks)).toHaveLength(DAILY_DRIPS);
    const others = await Promise.all(Array.from({ length: 3 }, async () => (await generateKeyPairSigner()).address));
    for (let i = 0; i < others.length; i += 1) expect((await drip(post(others[i], `203.0.113.${i + 50}`), h.deps)).status).toBe(200);
  });

  it("says per instance and reads as a daily limit", () => {
    expect(REASONS.instance).toContain("This faucet instance");
    expect(REASONS.instance).toContain("daily limit of drips");
    expect(REASONS.instance).toContain("wait retry_after seconds");
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
