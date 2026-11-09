import { describe, expect, it } from "vitest";
import { DEMO, NOW, ScriptedChain, SETTINGS, START_BALANCE, WORKER } from "./demo-worker-chain.js";
import { type Event, type Found, type Settings, worker } from "./demo-worker-module.js";

const { collectRound, emptyLedger, fastWork, healthOf, reclaimRound, roundsOf, serialized, workJobs } = worker;

const shown = (events: Event[]) => events.map(({ intent, action }) => `${action} ${intent}`);

const UNSEALABLE = ["4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxD4", "Gx9dDNxzpALCowVuZb7pBceBLJugLA8sPa6TJDXrpfeW"];

async function trapCycles(chain: ScriptedChain, ledger: ReturnType<typeof emptyLedger>, cycles: number, prepare: (found: Found[]) => void): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const found = ["H1", "H2", "H3"].map((owner, at) => chain.escrow(`c${cycle}-${at}`, { owner: `${owner}-${cycle}`, stake: 50_000_000n, reviewSecs: 600, maxSecs: 120 }));
    prepare(found);
    const start = chain.now;
    for (let t = 0; t <= 600; t += 30) {
      chain.now = start + t;
      if (t % 300 === 0) {
        await collectRound(chain.cli, SETTINGS, ledger, chain.now);
      }
      await fastWork(chain.cli, found, SETTINGS, ledger, chain.now);
    }
    chain.ownerTakesLapsed();
  }
}

describe("the unsealable-attestor drain", () => {
  it("never stakes on an escrow whose delivery cannot be sealed, and records it as done with the reason", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const found = UNSEALABLE.map((attestor, at) => {
      const each = chain.escrow(`unsealable-${at}`, { owner: `H${at}`, stake: 50_000_000n, reviewSecs: 600, maxSecs: 120 });
      chain.unsealable.add(each.job.intent);
      return each;
    });
    const events = await workJobs(chain.cli, found, SETTINGS, ledger, chain.now);
    expect(events.map(({ action }) => action)).toEqual(["skipped", "skipped", "skipped"]);
    expect(events[0]?.detail).toContain("cannot even be previewed, so no claim was staked on it");
    expect(events[0]?.detail).toContain("has no encryption key");
    expect(chain.count("claims take")).toBe(0);
    expect([...ledger.done].sort()).toEqual(found.map(({ job }) => job.intent).sort());
    expect(await workJobs(chain.cli, found, SETTINGS, ledger, chain.now)).toEqual([]);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("holds its balance through the review's 13 ten-minute trap cycles of 3 owners with 120-second claims", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    await trapCycles(chain, ledger, 13, () => chain.failNext.set("deliver", 1_000_000));
    expect(chain.count("claims take")).toBe(0);
    expect(chain.balance()).toBe(START_BALANCE);
  });

  it("gives a claim back inside the same step when the delivery after it fails, so no claim term can lapse, and logs the claim", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    await trapCycles(chain, ledger, 13, (found) => found.forEach(({ job }) => chain.failYes.add(job.intent)));
    expect(chain.balance()).toBe(START_BALANCE);
    const fresh = new ScriptedChain();
    const one = fresh.escrow("trap", { stake: 50_000_000n, reviewSecs: 600, maxSecs: 120 });
    fresh.failYes.add("trap");
    const events = await workJobs(fresh.cli, [one], SETTINGS, emptyLedger(), fresh.now);
    expect(shown(events)).toEqual(["claimed trap", "dropped trap"]);
    expect(events[1]?.detail).toContain("its delivery failed (deliver --keypair failed: the program refused the announcement), so the worker gave the claim back with its stake at once: drop-trap");
    expect(fresh.balance()).toBe(START_BALANCE);
  });
});

describe("the demo worker's breaker", () => {
  const failing = (chain: ScriptedChain, name: string, owner: string) => {
    const found = chain.escrow(name, { owner, stake: 10_000_000n });
    chain.failYes.add(name);
    return found;
  };

  it("stops staked claims of an owner after its strikes, and all staked claims after the global strikes, until the window passes", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const settings: Settings = { ...SETTINGS, breaker: { strikes: 2, ownerStrikes: 1, windowSecs: 3_600 } };
    expect(shown(await workJobs(chain.cli, [failing(chain, "a1", "A")], settings, ledger, chain.now))).toEqual(["claimed a1", "dropped a1"]);
    const again = await workJobs(chain.cli, [chain.escrow("a2", { owner: "A", stake: 10_000_000n })], settings, ledger, chain.now);
    expect(again.map(({ action }) => action)).toEqual(["skipped"]);
    expect(again[0]?.detail).toBe(`the breaker is open for owner A after 1 lost or failed claims on its escrows, so this worker takes no staked claim of it until ${NOW + 3_600}`);
    expect(shown(await workJobs(chain.cli, [failing(chain, "b1", "B")], settings, ledger, chain.now))).toEqual(["claimed b1", "dropped b1"]);
    const blocked = await workJobs(chain.cli, [chain.escrow("c1", { owner: "C", stake: 10_000_000n })], settings, ledger, chain.now);
    expect(blocked[0]?.detail).toBe(`the breaker is open after 2 lost or failed claims within 3600 seconds, so this worker takes no staked claim until ${NOW + 3_600}`);
    expect(healthOf(ledger, WORKER, chain.now, null, 0, settings)).toMatchObject({ strikes_recent: 2, breaker_until: new Date((NOW + 3_600) * 1000).toISOString(), alerts: ["breaker"] });
    expect(shown(await workJobs(chain.cli, [chain.escrow("free", { owner: "C", stake: 0n })], settings, ledger, chain.now))).toEqual(["claimed free", "delivered free"]);
    chain.now = NOW + 3_600;
    expect(shown(await workJobs(chain.cli, [chain.escrow("c2", { owner: "C", stake: 10_000_000n })], settings, ledger, chain.now))).toEqual(["claimed c2", "delivered c2"]);
    expect(chain.balance()).toBe(START_BALANCE - 10_000_000n);
  });

  it("refuses a staked claim whose review window is longer than its cap, so one hirer cannot lock the stake cap for long", async () => {
    const chain = new ScriptedChain();
    const events = await workJobs(chain.cli, [chain.escrow("slow", { stake: 10_000_000n, reviewSecs: 172_800, expiresIn: 400_000 })], SETTINGS, emptyLedger(), chain.now);
    expect(events.map(({ action, detail }) => [action, detail])).toEqual([["skipped", "its review window of 172800 seconds is longer than this worker's cap of 86400, so its stake would stay locked too long"]]);
    expect(chain.count("claims take")).toBe(0);
  });
});

describe("the demo worker's loss alert", () => {
  it("shows a lost stake in lost_recent_lamports and alerts, while overdue_lamports stays 0, until the window passes", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const settings: Settings = { ...SETTINGS, breaker: { strikes: 3, ownerStrikes: 3, windowSecs: 3_600 } };
    const found = chain.escrow("stuck", { stake: 10_000_000n, maxSecs: 120 });
    chain.failYes.add("stuck");
    chain.failNext.set("claims drop", 1);
    expect(shown(await workJobs(chain.cli, [found], settings, ledger, chain.now))).toEqual(["claimed stuck", "failed stuck"]);
    chain.now += 120;
    chain.ownerTakesLapsed();
    expect(shown(await collectRound(chain.cli, settings, ledger, chain.now))).toEqual(["lost stuck"]);
    expect(healthOf(ledger, WORKER, chain.now, null, 0, settings)).toMatchObject({ overdue_lamports: "0", lost_lamports: "10000000", lost_recent_lamports: "10000000", alerts: ["lost"] });
    expect(healthOf(ledger, WORKER, chain.now + 3_600, null, 0, settings)).toMatchObject({ lost_recent_lamports: "0", alerts: [] });
  });

  it("drops a claim whose delivery is still failing before its term runs out, from the collect round", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const found = chain.escrow("late", { stake: 10_000_000n, maxSecs: 300 });
    chain.failYes.add("late");
    chain.failNext.set("claims drop", 1);
    await workJobs(chain.cli, [found], SETTINGS, ledger, chain.now);
    expect(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 60)).toEqual([]);
    expect(shown(await collectRound(chain.cli, SETTINGS, ledger, chain.now + 240))).toEqual(["dropped late"]);
    expect(chain.balance()).toBe(START_BALANCE);
  });
});

describe("the demo worker's announcement rent", () => {
  it("stops delivering at its cap of open announcements and resumes once reclaim gets their rent back", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const settings: Settings = { ...SETTINGS, maxOpenDeliveries: 2 };
    const found = ["r1", "r2", "r3"].map((name) => chain.escrow(name, { stake: 0n }));
    expect(shown(await workJobs(chain.cli, found, settings, ledger, chain.now))).toEqual(["claimed r1", "delivered r1", "claimed r2", "delivered r2", "skipped r3"]);
    expect(healthOf(ledger, WORKER, chain.now, null, 0, settings)).toMatchObject({ open_deliveries: 2, alerts: ["rent"] });
    chain.closable.add("r1");
    expect(shown(await reclaimRound(chain.cli, settings, ledger))).toEqual([`reclaimed ${WORKER}`]);
    expect(ledger.openDeliveries).toBe(1);
    expect(shown(await workJobs(chain.cli, found, settings, ledger, chain.now))).toEqual(["claimed r3", "delivered r3"]);
  });

  it("reclaims from the collect round once per reclaim interval", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    const deps = { cli: chain.cli, read: async () => [], demos: [DEMO], settings: SETTINGS, ledger, now: () => chain.now, lock: serialized(), saved: async (events: Event[]) => events, reclaimSecs: 3_600 };
    const rounds = roundsOf(deps);
    await rounds.collect();
    await rounds.collect();
    chain.now += 3_600;
    await rounds.collect();
    expect(chain.count("reclaim")).toBe(2);
  });
});

describe("the demo worker's rounds", () => {
  it("keeps collecting while the fast round waits on the node, since it reads outside the round lock", async () => {
    const chain = new ScriptedChain();
    const ledger = emptyLedger();
    let release: () => void = () => undefined;
    const read = () => new Promise<Found[]>((done) => (release = () => done([])));
    const rounds = roundsOf({ cli: chain.cli, read, demos: [DEMO], settings: SETTINGS, ledger, now: () => chain.now, lock: serialized(), saved: async (events: Event[]) => events, reclaimSecs: 3_600 });
    const fast = rounds.fast();
    const collected = await Promise.race([rounds.collect().then(() => "collected"), new Promise((done) => setTimeout(() => done("stalled"), 500))]);
    release();
    await fast;
    expect(collected).toBe("collected");
  });
});
