import { NATIVE_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { pruned } from "../src/apply.js";
import { KEPT_PAID } from "../src/limits.js";
import { render } from "../src/render.js";
import { emptyState, type Paid } from "../src/shapes.js";
import { addressOf, attested, claimed, JUDGE, OWNER, released, signatureOf, split, splitAccounts, splitCall, type SplitClaim, type Tx, WORKER } from "./chain.js";
import { HOUR_SECS, NOW, nowSecs, rig } from "./harness.js";

const JOB = addressOf(1);
const SPLIT_JOB = addressOf(2);
const ALICE = addressOf(123);
const BOB = addressOf(124);
const CAROL = addressOf(125);
const THREE: SplitClaim = { recipients: [ALICE, BOB, CAROL], weights: [3000, 5000, 2000] };
const SLOT = 7000;

const inSlot = (n: number, events: Uint8Array[], extra: Partial<Tx> = {}): Tx => ({ signature: signatureOf(n), slot: SLOT, blockTime: nowSecs(-HOUR_SECS), events, ...extra });

describe("events of one slot", () => {
  it("keep the order the node listed them in after a late read", async () => {
    const { node, feed, tick } = rig();
    node.add(inSlot(1, [claimed(JOB, WORKER, 0n)]), inSlot(2, [claimed(JOB, ALICE, 0n)]), inSlot(3, [claimed(JOB, BOB, 0n)]));
    const held = node.transactions.get(signatureOf(2));
    node.transactions.delete(signatureOf(2));
    expect((await feed.read()).events.map(({ signature }) => signature)).toEqual([signatureOf(3), signatureOf(1)]);
    node.transactions.set(signatureOf(2), held);
    tick(31);
    expect((await feed.read()).events.map(({ signature }) => signature)).toEqual([signatureOf(3), signatureOf(2), signatureOf(1)]);
  });

  it("keep listing order when the late one is the newest of the slot", async () => {
    const { node, feed, tick } = rig();
    node.add(inSlot(1, [claimed(JOB, WORKER, 0n)]), inSlot(2, [claimed(JOB, ALICE, 0n)]));
    const held = node.transactions.get(signatureOf(2));
    node.transactions.delete(signatureOf(2));
    await feed.read();
    node.transactions.set(signatureOf(2), held);
    tick(31);
    expect((await feed.read()).events.map(({ signature }) => signature)).toEqual([signatureOf(2), signatureOf(1)]);
  });
});

describe("a split release event", () => {
  it("names all three recipient wallets with their shares", async () => {
    const { node, feed } = rig();
    node.add(
      inSlot(1, [released(SPLIT_JOB, ALICE, JUDGE), split(SPLIT_JOB, OWNER, ALICE, JUDGE, 1_000_000_000n, 3)], {
        calls: [{ data: splitCall(THREE, 1_000_000_000n), accounts: splitAccounts(SPLIT_JOB) }],
        holdings: THREE.recipients.map((owner, i) => ({ account: addressOf(140 + i), mint: NATIVE_MINT, owner })),
      }),
    );
    const release = (await feed.read()).events.find(({ kind }) => kind === "release");
    expect(release?.shares).toEqual([
      { payee: ALICE, amount: "0.3" },
      { payee: BOB, amount: "0.5" },
      { payee: CAROL, amount: "0.2" },
    ]);
    expect(release?.payee).toBe(ALICE);
    for (const wallet of THREE.recipients) {
      expect(release?.detail).toContain(wallet.slice(0, 4));
    }
  });

  it("leaves the shares off a single-payee release", async () => {
    const { node, feed } = rig();
    node.add(inSlot(1, [released(JOB, WORKER, JUDGE), attested(JOB, OWNER, WORKER, JUDGE, 1_000n)], { holdings: [{ account: addressOf(140), mint: NATIVE_MINT, owner: WORKER }] }));
    const release = (await feed.read()).events.find(({ kind }) => kind === "release");
    expect(release).toBeDefined();
    expect(release).not.toHaveProperty("shares");
  });
});

describe("the paid cap at a split", () => {
  const entry = (n: number, intent: string, signature: string, payee: string): Paid => ({
    at: new Date(NOW - (KEPT_PAID + 100 - n) * 1000).toISOString(),
    slot: 1_000_000 + n,
    signature,
    intent,
    payee,
    token: "SOL",
    raw: "10",
    decimals: 9,
    house: false,
  });
  const splitEntries = (n: number): Paid[] => [ALICE, BOB, CAROL].map((payee) => entry(n, SPLIT_JOB, "split-signature", payee));
  const singles = (from: number, count: number): Paid[] => Array.from({ length: count }, (_, i) => entry(from + i, addressOf(10 + (i % 100)), `single-${from + i}`, WORKER));

  const kept = (older: Paid[], newer: Paid[]) => {
    const state = emptyState();
    state.paid.push(...newer, ...older);
    pruned(state, NOW);
    return state;
  };

  it("drops a split whole when only part of it fits", () => {
    const state = kept(splitEntries(1), singles(10, KEPT_PAID - 1));
    expect(state.paid.some(({ intent }) => intent === SPLIT_JOB)).toBe(false);
    expect(state.paid).toHaveLength(KEPT_PAID - 1);
    const body = render(state, new Set(), NOW);
    expect(body.stats.paid_jobs_7d).toBe(KEPT_PAID - 1);
    expect(body.stats.paid_7d).toEqual([{ token: "SOL", amount: "0.00001999" }]);
  });

  it("keeps a split whole when all of it fits", () => {
    const state = kept(splitEntries(1), singles(10, KEPT_PAID - 3));
    expect(state.paid.filter(({ intent }) => intent === SPLIT_JOB)).toHaveLength(3);
    expect(state.paid).toHaveLength(KEPT_PAID);
    const body = render(state, new Set(), NOW);
    expect(body.stats.paid_jobs_7d).toBe(KEPT_PAID - 2);
  });
});
