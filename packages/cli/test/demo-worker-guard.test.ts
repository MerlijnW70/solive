import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO, NOW, ScriptedChain, SETTINGS, START_BALANCE, WORKER } from "./demo-worker-chain.js";
import { type Event, type Settings, worker } from "./demo-worker-module.js";

const { collectRound, emptyLedger, healthOf, MAX_FAILURES, OVERDUE_SECS, readLedger, workJobs, writeLedger } = worker;

const shown = (events: Event[]) => events.map(({ intent, action }) => `${action} ${intent}`);

const temp: string[] = [];
afterAll(async () => {
  await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
});

const statePath = async () => {
  const dir = await mkdtemp(join(tmpdir(), "demo-guard-"));
  temp.push(dir);
  return join(dir, "state.json");
};

describe("the demo worker's claim policy", () => {
  it("skips a staked claim whose board opens no review window, says why, and never reads that board again", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const found = [chain.escrow("no-review", { stake: 50_000_000n, reviewSecs: 0 })];
    const events = await workJobs(chain.cli, found, SETTINGS, ledger, chain.now);
    expect(events.map(({ action, detail }) => [action, detail])).toEqual([["skipped", "its claims open no review window, so a delivery its judge never answers would lose the stake of 50000000 lamports to the owner"]]);
    expect(chain.count("claims take")).toBe(0);
    expect(chain.count("deliver")).toBe(0);
    expect(await workJobs(chain.cli, found, SETTINGS, ledger, chain.now)).toEqual([]);
    expect(chain.count("claims show")).toBe(1);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("claims and delivers a claim whose stake is 0, even without a review window, and holds nothing at risk", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const events = await workJobs(chain.cli, [chain.escrow("free-claim", { stake: 0n, reviewSecs: 0 })], SETTINGS, ledger, chain.now);
    expect(shown(events)).toEqual(["claimed free-claim", "delivered free-claim"]);
    expect(ledger.holds.size).toBe(0);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("takes a protected claim: it leaves the judge the whole review window and delivers only after the preview says protected", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const [found] = [chain.escrow("protected", { stake: 20_000_000n, reviewSecs: 3_600, killFee: 5_000_000n })];
    expect(shown(await workJobs(chain.cli, [found], SETTINGS, ledger, chain.now))).toEqual(["claimed protected", "delivered protected"]);
    const verbs = chain.calls.map((args) => (args[0] === "deliver" ? (args.includes("--yes") ? "deliver" : "preview") : `${args[0]} ${args[1]}`));
    expect(verbs).toEqual(["claims show", "preview", "claims take", "preview", "deliver"]);
    expect(ledger.holds.get("protected")).toMatchObject({ stake: "20000000", killFee: "5000000", delivered: true, reviewUntil: NOW + 3_600 });
    expect(healthOf(ledger, WORKER, chain.now, null, 0, SETTINGS).stake_at_risk_lamports).toBe("20000000");
  });

  it("leaves an escrow whose expiry leaves no room for a claim and the whole review window", async () => {
    const chain = new ScriptedChain();
    const events = await workJobs(chain.cli, [chain.escrow("tight", { reviewSecs: 86_400, expiresIn: 86_400 + 100 })], SETTINGS, emptyLedger(), chain.now);
    expect(events.map(({ action }) => action)).toEqual(["skipped"]);
    expect(chain.count("claims take")).toBe(0);
  });

  it("gives a claim back, with its stake, when the delivery preview says it arms no review", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const found = chain.escrow("odd", { stake: 10_000_000n });
    chain.unprotected.add("odd");
    const events = await workJobs(chain.cli, [found], SETTINGS, ledger, chain.now);
    expect(shown(events)).toEqual(["claimed odd", "dropped odd"]);
    expect(events[1]?.detail).toContain("the escrow's claims open no review window");
    expect(chain.calls.filter((args) => args[0] === "deliver" && args.includes("--yes"))).toEqual([]);
    expect(ledger.holds.size).toBe(0);
    expect(chain.balance()).toBe(START_BALANCE);
  });
});

describe("the demo worker's caps", () => {
  it("never holds more stake at risk than its cap, and claims again once a hold ends", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const settings: Settings = { ...SETTINGS, maxAtRisk: 30_000_000n };
    const found = ["a", "b", "c", "d"].map((name) => chain.escrow(name, { stake: 10_000_000n }));
    const events = await workJobs(chain.cli, found, settings, ledger, chain.now);
    expect(shown(events)).toEqual(["claimed a", "delivered a", "claimed b", "delivered b", "claimed c", "delivered c", "skipped d"]);
    expect(events.at(-1)?.detail).toBe("claiming it would put 40000000 lamports of stake at risk, above this worker's cap of 30000000");
    expect(START_BALANCE - chain.balance()).toBe(30_000_000n);
    chain.release("a");
    chain.now += 600;
    await collectRound(chain.cli, settings, ledger, chain.now);
    expect(shown(await workJobs(chain.cli, found, settings, ledger, chain.now))).toEqual(["claimed d", "delivered d"]);
    expect(healthOf(ledger, WORKER, chain.now, null, 0, SETTINGS).stake_at_risk_lamports).toBe("30000000");
  });

  it("never stakes more on one owner's escrows than its cap per owner", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const found = [chain.escrow("first", { owner: "Hirer", stake: 30_000_000n }), chain.escrow("second", { owner: "Hirer", stake: 30_000_000n }), chain.escrow("other", { owner: "Else", stake: 30_000_000n })];
    const events = await workJobs(chain.cli, found, SETTINGS, ledger, chain.now);
    expect(shown(events)).toEqual(["claimed first", "delivered first", "skipped second", "claimed other", "delivered other"]);
    expect(events[2]?.detail).toBe("claiming it would stake 60000000 lamports on escrows of owner Hirer, above this worker's cap of 50000000 per owner");
  });
});

describe("the demo worker's collect", () => {
  it("collects the stake and kill fee of a review that ended unanswered exactly once, also across a restart", async () => {
    const chain = new ScriptedChain();
    const path = await statePath();
    const ledger = emptyLedger();
    await workJobs(chain.cli, [chain.escrow("silent", { stake: 20_000_000n, killFee: 5_000_000n })], SETTINGS, ledger, chain.now);
    await writeLedger(path, ledger);
    chain.now += 1_800;
    const early = await readLedger(path);
    expect(await collectRound(chain.cli, SETTINGS, early, chain.now)).toEqual([]);
    expect(chain.count("claims show")).toBe(2);
    expect(await collectRound(chain.cli, SETTINGS, early, chain.now + 60)).toEqual([]);
    expect(chain.count("claims show")).toBe(2);
    chain.now += 1_800;
    const restarted = await readLedger(path);
    expect(healthOf(restarted, WORKER, chain.now, null, 0, SETTINGS)).toMatchObject({ uncollected_lamports: "25000000", overdue_lamports: "0" });
    expect(shown(await collectRound(chain.cli, SETTINGS, restarted, chain.now))).toEqual(["collected silent"]);
    await writeLedger(path, restarted);
    expect(chain.balance()).toBe(START_BALANCE + 5_000_000n);
    chain.now += 600;
    expect(await collectRound(chain.cli, SETTINGS, await readLedger(path), chain.now)).toEqual([]);
    expect(await collectRound(chain.cli, SETTINGS, restarted, chain.now)).toEqual([]);
    expect(chain.count("claims collect")).toBe(1);
    expect(healthOf(await readLedger(path), WORKER, chain.now, null, 0, SETTINGS)).toMatchObject({ stake_at_risk_lamports: "0", uncollected_lamports: "0", collected_lamports: "25000000", claims_held: 0 });
  });

  it("retries a failed collect later, waiting longer each time, and never sends two", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    await workJobs(chain.cli, [chain.escrow("flaky", { stake: 20_000_000n })], SETTINGS, ledger, chain.now);
    chain.now += 3_600;
    chain.failNext.set("claims collect", 2);
    expect(shown(await collectRound(chain.cli, SETTINGS, ledger, chain.now))).toEqual(["failed flaky"]);
    expect(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 30)).toEqual([]);
    expect(shown(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 60))).toEqual(["failed flaky"]);
    expect(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 150)).toEqual([]);
    expect(shown(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 180))).toEqual(["collected flaky"]);
    expect(chain.count("claims collect")).toBe(3);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("records the end of a hold the judge settled and drops a claim whose delivery failed for good", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const settled = chain.escrow("released", { stake: 10_000_000n });
    await workJobs(chain.cli, [settled], SETTINGS, ledger, chain.now);
    chain.release("released");
    chain.now += 3_600;
    expect(shown(await collectRound(chain.cli, SETTINGS, ledger, chain.now))).toEqual(["ended released"]);
    const stuck = chain.escrow("stuck", { stake: 10_000_000n });
    chain.failYes.add("stuck");
    chain.failNext.set("claims drop", 1);
    expect(shown(await workJobs(chain.cli, [stuck], SETTINGS, ledger, chain.now))).toEqual(["claimed stuck", "failed stuck"]);
    expect(ledger.failures.get("stuck")).toBeLessThan(MAX_FAILURES);
    expect(shown(await workJobs(chain.cli, [stuck], SETTINGS, ledger, chain.now))).toEqual(["dropped stuck"]);
    expect(ledger.done.has("stuck")).toBe(true);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("adopts a claim it holds but never recorded, such as after a crash, so its stake is still watched", async () => {
    const chain = new ScriptedChain();
    const found = chain.escrow("orphan", { stake: 10_000_000n });
    await chain.cli(["claims", "take", "--keypair", "k.json", "--owner", found.job.owner, "--nonce", found.job.nonce, "--secs", "900", "--yes"]);
    const ledger = emptyLedger();
    const events = await workJobs(chain.cli, [{ ...found, job: { ...found.job, claimedBy: WORKER } }], SETTINGS, ledger, chain.now);
    expect(shown(events)).toEqual(["delivered orphan"]);
    expect(ledger.holds.get("orphan")).toMatchObject({ stake: "10000000", delivered: true, reviewUntil: NOW + 3_600 });
  });

  it("names lamports owed for over an hour in overdue_lamports, the field the monitor alerts on", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    await workJobs(chain.cli, [chain.escrow("late", { stake: 20_000_000n, killFee: 5_000_000n })], SETTINGS, ledger, chain.now);
    const ended = NOW + 3_600;
    expect(healthOf(ledger, WORKER, ended + OVERDUE_SECS - 1, 7n, 0, SETTINGS)).toMatchObject({ uncollected_lamports: "25000000", overdue_lamports: "0", balance_lamports: "7" });
    expect(healthOf(ledger, WORKER, ended + OVERDUE_SECS, 7n, 0, SETTINGS).overdue_lamports).toBe("25000000");
    expect(Object.keys(healthOf(ledger, WORKER, ended, null, 0, SETTINGS)).sort()).toEqual(
      ["alerts", "at", "balance_lamports", "breaker_until", "claims_held", "collected_lamports", "last_delivery", "lost_lamports", "lost_recent_lamports", "node_busy_until", "open_deliveries", "overdue_lamports", "stake_at_risk_lamports", "state_recovered", "strikes_recent", "uncollected_lamports", "wallet"].sort(),
    );
    expect(healthOf(ledger, WORKER, ended, null, 0, SETTINGS).last_delivery).toEqual({ at: new Date(NOW * 1000).toISOString(), intent: "late" });
  });
});

describe("the audit's drain probe", () => {
  it("takes no claim on boards without a review window, so a hirer who never judges cannot drain the worker", async () => {
    const calls: string[][] = [];
    const cli = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "claims" && args[1] === "show") return { state: "open", stake: "50000000", max_secs: 7200, review_secs: 0, kill_fee: "0", line: { waiting: 0 } };
      if (args[0] === "claims" && args[1] === "take") return { sent: true, signature: "SIGTAKE" };
      if (args[0] === "deliver") return { sent: true, signature: "SIGDELIVER", protected: false };
      throw new Error("unexpected " + args.join(" "));
    };
    const jobs = Array.from({ length: 5 }, (_, i) => ({ demo: DEMO, job: { intent: "I" + i, owner: "ATTACKER", nonce: String(i), specHash: DEMO.specHash, takesClaims: true, claimedBy: null, waiting: 0, expiresAt: NOW + 86400 } }));
    const events = await workJobs(cli, jobs, { ...SETTINGS, wallet: "WORKER", keypair: "k.json" }, emptyLedger(), NOW);
    expect(events.map((e) => [e.intent, e.action])).toEqual(jobs.map(({ job }) => [job.intent, "skipped"]));
    expect(calls.filter((c) => c[1] === "take")).toHaveLength(0);
    expect(calls.filter((c) => c[0] === "deliver")).toHaveLength(0);

    const chain = new ScriptedChain();
    const found = Array.from({ length: 30 }, (_, i) => chain.escrow(`drain-${i}`, { owner: "ATTACKER", stake: 50_000_000n, reviewSecs: 0 }));
    await workJobs(chain.cli, found, SETTINGS, emptyLedger(), chain.now);
    chain.now += 7_200;
    chain.ownerTakesLapsed();
    expect(chain.balance()).toBe(START_BALANCE);
    expect(chain.balance("ATTACKER")).toBe(0n);
  });
});
