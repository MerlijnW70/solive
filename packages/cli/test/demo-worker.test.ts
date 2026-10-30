import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Cli, type Demo, demoRound, emptyLedger, jobsOf, loadDemos, MAX_FAILURES, readLedger, type Settings, writeLedger } from "../../../scripts/demo-worker.mjs";
import { DEMO_BASE_URL, DEMO_SPECS } from "../src/agent/mcp.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEMO_DIR = join(ROOT, "examples", "demo");
const WORKER = "Worker1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const NOW = 1_800_000_000;
const SETTINGS: Settings = { keypair: "/tmp/demo-worker.json", wallet: WORKER, maxStake: 50_000_000n, claimSecs: 900 };

type Listed = { intent: string; specHash: string; takes_claims?: boolean; claimed_by?: string | null; waiting?: number; expiresAt?: string };

const listed = ({ intent, specHash, takes_claims = false, claimed_by = null, waiting = 0, expiresAt = String(NOW + 86_400) }: Listed) => ({
  intent,
  owner: `owner-of-${intent}`,
  nonce: "7",
  attestor: "Judge111111111111111111111111111111111111111",
  specHash,
  specUrl: null,
  expiresAt,
  takes_claims,
  claimed_by,
  claim_ends: null,
  waiting,
});

type Stub = { cli: Cli; calls: string[][] };

function stub(jobs: () => object[], answers: { stake?: string; maxSecs?: number; failDeliver?: number; delivered?: object } = {}): Stub {
  const calls: string[][] = [];
  let deliverFailures = answers.failDeliver ?? 0;
  const cli: Cli = async (args) => {
    calls.push([...args]);
    const [verb, sub] = args;
    if (verb === "jobs") {
      return { jobs: jobs() };
    }
    if (verb === "claims" && sub === "show") {
      return { state: "free", worker: null, stake: answers.stake ?? "1000000", max_secs: answers.maxSecs ?? 3600 };
    }
    if (verb === "claims" && sub === "take") {
      return { sent: true, signature: `claim-${args[args.indexOf("--owner") + 1]}` };
    }
    if (verb === "deliver") {
      if (deliverFailures > 0) {
        deliverFailures -= 1;
        throw new Error("deliver failed: the node timed out");
      }
      return answers.delivered ?? { sent: true, signature: `announce-${args[args.indexOf("--intent") + 1]}` };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return { cli, calls };
}

const verbs = (calls: string[][]) => calls.map((args) => (args[0] === "claims" ? `claims ${args[1]}` : (args[0] ?? "")));
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const temp: string[] = [];
afterAll(async () => {
  await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the demo worker", () => {
  it("loads every demo in examples/demo with the spec hash the guide pins and a work url beside its spec", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    expect(demos.map(({ name, specHash }) => ({ name, sha256: specHash }))).toEqual(DEMO_SPECS.map(({ name, sha256 }) => ({ name, sha256 })));
    for (const demo of demos) {
      expect(demo.solution).toBe(join(DEMO_DIR, demo.name, "solution.mjs"));
      expect(demo.workUrl).toBe(`${DEMO_BASE_URL}/${demo.name}/solution.mjs`);
      expect(createHash("sha256").update(await readFile(demo.solution)).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("delivers only escrows of a demo spec, claims those that take claims, ignores the rest, and delivers each once", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const [fizz, palindrome, reverse] = demos as [Demo, Demo, Demo];
    const open = [
      listed({ intent: "plain-demo", specHash: fizz.specHash }),
      listed({ intent: "claimable-demo", specHash: palindrome.specHash, takes_claims: true }),
      listed({ intent: "held-by-other", specHash: reverse.specHash, takes_claims: true, claimed_by: OTHER }),
      listed({ intent: "line-waiting", specHash: reverse.specHash, takes_claims: true, waiting: 1 }),
      listed({ intent: "held-by-me", specHash: reverse.specHash.toUpperCase(), takes_claims: true, claimed_by: WORKER }),
      listed({ intent: "not-a-demo", specHash: "ab".repeat(32) }),
      listed({ intent: "not-a-demo-with-claims", specHash: "cd".repeat(32), takes_claims: true }),
      { intent: "unreadable" },
    ];
    const { cli, calls } = stub(() => open);
    const ledger = emptyLedger();
    const events = await demoRound(cli, demos, SETTINGS, ledger, NOW);
    expect(verbs(calls)).toEqual(["jobs", "deliver", "claims show", "claims take", "deliver", "deliver"]);
    const delivered = calls.filter(([verb]) => verb === "deliver");
    expect(delivered.map((args) => argOf(args, "--intent"))).toEqual(["plain-demo", "claimable-demo", "held-by-me"]);
    expect(delivered.map((args) => [argOf(args, "--artifact"), argOf(args, "--work-url"), argOf(args, "--keypair"), args.at(-1)])).toEqual([
      [fizz.solution, fizz.workUrl, SETTINGS.keypair, "--yes"],
      [palindrome.solution, palindrome.workUrl, SETTINGS.keypair, "--yes"],
      [reverse.solution, reverse.workUrl, SETTINGS.keypair, "--yes"],
    ]);
    const take = calls.find((args) => args[0] === "claims" && args[1] === "take") ?? [];
    expect([argOf(take, "--owner"), argOf(take, "--nonce"), argOf(take, "--secs"), argOf(take, "--keypair")]).toEqual(["owner-of-claimable-demo", "7", "900", SETTINGS.keypair]);
    expect(events.map(({ intent, action }) => `${action} ${intent}`)).toEqual([
      "delivered plain-demo",
      "claimed claimable-demo",
      "delivered claimable-demo",
      "skipped held-by-other",
      "skipped line-waiting",
      "delivered held-by-me",
    ]);
    expect([...ledger.done].sort()).toEqual(["claimable-demo", "held-by-me", "plain-demo"]);

    calls.length = 0;
    expect(await demoRound(cli, demos, SETTINGS, ledger, NOW + 30)).toEqual([]);
    expect(verbs(calls)).toEqual(["jobs"]);
  });

  it("delivers nothing again after a restart that reads the saved ledger", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const dir = await mkdtemp(join(tmpdir(), "demo-worker-"));
    temp.push(dir);
    const path = join(dir, "state.json");
    expect((await readLedger(path)).done.size).toBe(0);
    const open = [listed({ intent: "once", specHash: (demos[0] as Demo).specHash })];
    const first = stub(() => open);
    const ledger = await readLedger(path);
    await demoRound(first.cli, demos, SETTINGS, ledger, NOW);
    await writeLedger(path, ledger);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ done: ["once"] });
    const second = stub(() => open);
    expect(await demoRound(second.cli, demos, SETTINGS, await readLedger(path), NOW)).toEqual([]);
    expect(verbs(second.calls)).toEqual(["jobs"]);
  });

  it("counts an announcement that is already on chain as delivered", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const { cli } = stub(() => [listed({ intent: "known", specHash: (demos[1] as Demo).specHash })], { delivered: { sent: false, next: "this work is already announced to this escrow with this url; nothing was sent" } });
    const ledger = emptyLedger();
    const events = await demoRound(cli, demos, SETTINGS, ledger, NOW);
    expect(events.map(({ action }) => action)).toEqual(["delivered"]);
    expect(ledger.done.has("known")).toBe(true);
  });

  it(`retries a failed delivery in later rounds and gives up after ${MAX_FAILURES} failures`, async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const open = [listed({ intent: "flaky", specHash: (demos[2] as Demo).specHash })];
    const { cli, calls } = stub(() => open, { failDeliver: MAX_FAILURES + 1 });
    const ledger = emptyLedger();
    const actions: string[] = [];
    for (let round = 0; round < MAX_FAILURES + 1; round += 1) {
      actions.push(...(await demoRound(cli, demos, SETTINGS, ledger, NOW)).map(({ action }) => action));
    }
    expect(actions).toEqual([...Array.from({ length: MAX_FAILURES - 1 }, () => "failed"), "gave-up"]);
    expect(calls.filter(([verb]) => verb === "deliver")).toHaveLength(MAX_FAILURES);
  });

  it("claims nothing whose stake is above its cap or whose escrow ends too soon, and says so once", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const hash = (demos[0] as Demo).specHash;
    const costly = stub(() => [listed({ intent: "costly", specHash: hash, takes_claims: true })], { stake: "60000000" });
    const ledger = emptyLedger();
    expect((await demoRound(costly.cli, demos, SETTINGS, ledger, NOW)).map(({ action, detail }) => [action, detail])).toEqual([
      ["skipped", "its claim stake of 60000000 lamports is above this worker's cap of 50000000"],
    ]);
    expect(await demoRound(costly.cli, demos, SETTINGS, ledger, NOW)).toEqual([]);
    expect(verbs(costly.calls).filter((verb) => verb === "claims take" || verb === "deliver")).toEqual([]);
    const late = stub(() => [listed({ intent: "late", specHash: hash, takes_claims: true, expiresAt: String(NOW + 100) })]);
    expect((await demoRound(late.cli, demos, SETTINGS, emptyLedger(), NOW)).map(({ action }) => action)).toEqual(["skipped"]);
    expect(verbs(late.calls)).toEqual(["jobs", "claims show"]);
  });

  it("reads the jobs the command line lists and drops entries it cannot read", () => {
    expect(jobsOf({ jobs: [listed({ intent: "a", specHash: "AB".repeat(32), takes_claims: true, claimed_by: OTHER }), { intent: "b" }, null] })).toEqual([
      { intent: "a", owner: "owner-of-a", nonce: "7", specHash: "ab".repeat(32), takesClaims: true, claimedBy: OTHER, waiting: 0, expiresAt: NOW + 86_400 },
    ]);
    expect(jobsOf({ next: "no job is open right now" })).toEqual([]);
  });
});
