import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { STATE_KEY } from "../src/limits.js";
import { emptyState } from "../src/shapes.js";
import { addressOf, attested, created, held, JUDGE, OWNER, released, signatureOf, split, splitAccounts, splitCall, type SplitClaim, type Tx, WORKER } from "./chain.js";
import { HOUR_SECS, nowSecs, rig } from "./harness.js";
import { untilComplete } from "./history-chain.js";

const WALLET = addressOf(120);
const FIRST_ACCOUNT = addressOf(121);
const SECOND_ACCOUNT = addressOf(122);
const ALICE = addressOf(123);
const BOB = addressOf(124);
const CAROL = addressOf(125);
const ORPHAN_ACCOUNT = addressOf(126);
const SPLIT_JOB = addressOf(127);
const OTHER_SPLIT = addressOf(128);
const DAVE = addressOf(129);

let n = 0;
const tx = (events: Uint8Array[], extra: Partial<Tx> = {}): Tx => {
  n += 1;
  return { signature: signatureOf(n), slot: 9000 + n, blockTime: nowSecs(-HOUR_SECS + n), events, ...extra };
};

const payTo = (intent: ReturnType<typeof addressOf>, account: ReturnType<typeof addressOf>, net: bigint, owner?: ReturnType<typeof addressOf>): Tx =>
  tx([released(intent, WORKER, JUDGE), attested(intent, OWNER, account, JUDGE, net)], {
    holdings: [{ account, mint: NATIVE_MINT, ...(owner === undefined ? {} : { owner }) }],
  });

const THREE: SplitClaim = { recipients: [ALICE, BOB, CAROL], weights: [3000, 5000, 2000] };

type Wallet = ReturnType<typeof addressOf>;

type SplitOptions = {
  committee?: boolean;
  heldBob?: boolean;
  recipients?: number;
  judge?: Wallet;
  mixed?: boolean;
  intent?: Wallet;
  owners?: Wallet[];
  held?: { wallet: Wallet; index: number; share: bigint };
  seed?: number;
};

const splitParts = (claim: SplitClaim, net: bigint, extra: SplitOptions = {}): Pick<Tx, "events" | "calls" | "holdings"> => {
  const intent = extra.intent ?? SPLIT_JOB;
  const judge = extra.judge ?? JUDGE;
  const kept = extra.held ?? (extra.heldBob === true ? { wallet: BOB, index: 1, share: (net * 5000n) / 10_000n } : undefined);
  const owners = extra.owners ?? claim.recipients.filter((_, index) => kept?.index !== index);
  return {
    events: [
      ...(kept === undefined ? [] : [held(intent, kept.wallet, kept.share, kept.index)]),
      released(intent, ALICE, judge),
      split(intent, OWNER, ALICE, judge, net, extra.recipients ?? claim.recipients.length),
    ],
    calls: [{ data: splitCall(claim, net, extra.committee === true), accounts: splitAccounts(intent) }],
    holdings: [
      ...owners.map((owner, i) => ({ account: addressOf((extra.seed ?? 140) + i), mint: NATIVE_MINT, owner })),
      ...(extra.mixed === true ? [{ account: addressOf(150), mint: DEVNET_TEST_MINT, owner: OWNER }] : []),
    ],
  };
};

const splitRelease = (claim: SplitClaim, net: bigint, extra: SplitOptions = {}): Tx => {
  const { events, ...rest } = splitParts(claim, net, extra);
  return tx(events, rest);
};

const listed = (raw: Record<string, unknown>) => ({ signature: raw["signature"] as string, slot: raw["slot"] as number, blockTime: raw["blockTime"] as number, err: null, memo: null });

describe("workers by wallet", () => {
  it("counts one wallet paid through two token accounts as one worker", async () => {
    const { node, feed } = rig();
    node.add(payTo(addressOf(130), FIRST_ACCOUNT, 10_000_000n, WALLET), payTo(addressOf(131), SECOND_ACCOUNT, 30_000_000n, WALLET));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 2, workers_7d: 1, paid_7d: [{ token: "SOL", amount: "0.04" }] });
    expect(body.top_workers).toEqual([{ wallet: WALLET, paid_jobs: 2, paid_sol: "0.04", house: false }]);
    expect(body.events.filter(({ kind }) => kind === "release").map(({ payee }) => payee)).toEqual([WALLET, WALLET]);
  });

  it("shows the owner wallet of saved devnet releases in top_workers, not the payee account", async () => {
    const saved = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "devnet-releases.json"), "utf8")) as Record<string, unknown>[];
    const { node, feed } = rig();
    for (const raw of saved) {
      const transaction = raw["transaction"] as { signatures: string[] };
      const signature = transaction.signatures[0] ?? "";
      node.program.unshift(listed({ ...raw, signature }));
      node.transactions.set(signature, raw);
    }
    const body = await feed.read();
    const owner = "GXxxgZLrxQFoXzw8kmk8TwGiKXSyaqnc9qvUh665fFjr";
    const account = "CBsbxbwhuzM5j7Xbkm4ZYwNHF56Pcd6PJqHtjEycj341";
    expect(body.top_workers).toEqual([{ wallet: owner, paid_jobs: 2, paid_sol: "0.0194", house: true }]);
    expect(body.stats).toMatchObject({ paid_jobs_7d: 2, workers_7d: 1, paid_7d: [{ token: "SOL", amount: "0.0194" }] });
    expect(body.events.map(({ payee }) => payee)).toEqual([owner, owner]);
    expect(JSON.stringify(body)).not.toContain(account);
  });

  it("credits each of three split recipients its own share and counts the split as one paid job", async () => {
    for (const committee of [false, true]) {
      const { node, feed } = rig();
      node.add(splitRelease(THREE, 1_000_000_001n, { committee }));
      const body = await feed.read();
      expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 3, paid_7d: [{ token: "SOL", amount: "1.000000001" }] });
      expect(body.top_workers).toEqual([
        { wallet: BOB, paid_jobs: 1, paid_sol: "0.500000001", house: false },
        { wallet: ALICE, paid_jobs: 1, paid_sol: "0.3", house: false },
        { wallet: CAROL, paid_jobs: 1, paid_sol: "0.2", house: false },
      ]);
      expect(body.events.filter(({ kind }) => kind === "release")).toHaveLength(1);
    }
  });

  it("counts a self-judged split once among house paid jobs", async () => {
    const { node, feed } = rig();
    node.add(splitRelease(THREE, 1_000_000_000n, { judge: OWNER }));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, house_paid_jobs_7d: 1, workers_7d: 3 });
  });

  it("credits each split share once the escrow names the mint of a release read before it", async () => {
    const { node, feed } = rig();
    node.add(splitRelease(THREE, 1_000_000_001n, { mixed: true }), tx([created(SPLIT_JOB, OWNER, 1_000_000_001n)]));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 3, paid_7d: [{ token: "SOL", amount: "1.000000001" }] });
    expect(body.top_workers.map(({ wallet, paid_sol }) => [wallet, paid_sol])).toEqual([
      [BOB, "0.500000001"],
      [ALICE, "0.3"],
      [CAROL, "0.2"],
    ]);
  });

  it("counts a split whose net is zero as one paid job of its announcing worker", async () => {
    const { node, feed } = rig();
    node.add(splitRelease(THREE, 0n));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 1, paid_7d: [{ token: "SOL", amount: "0" }] });
    expect(body.top_workers).toEqual([{ wallet: ALICE, paid_jobs: 1, paid_sol: "0", house: false }]);
  });

  it("skips a zero-weight recipient and gives the leftover unit to the first of tied heaviest weights", async () => {
    const { node, feed } = rig();
    node.add(splitRelease({ recipients: [ALICE, BOB, CAROL], weights: [5000, 5000, 0] }, 1_000_000_001n, { owners: [ALICE, BOB] }));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 2 });
    expect(body.top_workers.map(({ wallet, paid_sol }) => [wallet, paid_sol])).toEqual([
      [ALICE, "0.500000001"],
      [BOB, "0.5"],
    ]);
  });

  it("reads each split's own claim when one transaction releases two splits", async () => {
    const { node, feed } = rig();
    const first = splitParts(THREE, 1_000_000_001n);
    const second = splitParts({ recipients: [CAROL, DAVE], weights: [5000, 5000] }, 2_000_000_000n, { intent: OTHER_SPLIT, seed: 160 });
    node.add(tx([...first.events, ...second.events], { calls: [...(second.calls ?? []), ...(first.calls ?? [])], holdings: [...(first.holdings ?? []), ...(second.holdings ?? [])] }));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 2, workers_7d: 4, paid_7d: [{ token: "SOL", amount: "3.000000001" }] });
    expect(Object.fromEntries(body.top_workers.map(({ wallet, paid_jobs, paid_sol }) => [wallet, [paid_jobs, paid_sol]]))).toEqual({
      [ALICE]: [1, "0.3"],
      [BOB]: [1, "0.500000001"],
      [CAROL]: [2, "1.2"],
      [DAVE]: [1, "1"],
    });
  });

  it("falls back to the announcing worker when the balances or ShareHeld do not back the claim", async () => {
    const share = (1_000_000_000n * 5000n) / 10_000n;
    const cases: SplitOptions[] = [
      { owners: [ALICE, BOB] },
      { held: { wallet: BOB, index: 1, share: share - 1n } },
      { held: { wallet: CAROL, index: 1, share } },
    ];
    for (const extra of cases) {
      const { node, feed } = rig();
      node.add(splitRelease(THREE, 1_000_000_000n, extra));
      const body = await feed.read();
      expect(body.top_workers).toEqual([{ wallet: ALICE, paid_jobs: 1, paid_sol: "1", house: false }]);
    }
  });

  it("falls back to the announcing worker when the claim's weights do not sum to the whole", async () => {
    const { node, feed } = rig();
    node.add(splitRelease({ recipients: [ALICE, BOB, CAROL], weights: [3000, 5000, 1000] }, 1_000_000_000n));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 1 });
    expect(body.top_workers.map(({ wallet }) => wallet)).toEqual([ALICE]);
  });

  it("counts two releases of one intent in the same slot to different wallets as two paid jobs", async () => {
    const { node, feed } = rig();
    const intent = addressOf(137);
    const first = payTo(intent, FIRST_ACCOUNT, 10_000_000n, WALLET);
    const second = { ...payTo(intent, ORPHAN_ACCOUNT, 20_000_000n, DAVE), slot: first.slot };
    node.add(first, second);
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 2, workers_7d: 2, paid_7d: [{ token: "SOL", amount: "0.03" }] });
  });

  it("credits a held split share to the wallet the ShareHeld event names", async () => {
    const { node, feed } = rig();
    node.add(splitRelease(THREE, 1_000_000_000n, { heldBob: true }));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 3 });
    expect(body.top_workers.map(({ wallet, paid_sol }) => [wallet, paid_sol])).toEqual([
      [BOB, "0.5"],
      [ALICE, "0.3"],
      [CAROL, "0.2"],
    ]);
  });

  it("falls back to today's payee without a crash when the balances name no owner", async () => {
    const { node, feed } = rig();
    node.add(payTo(addressOf(132), ORPHAN_ACCOUNT, 5_000_000n), payTo(addressOf(133), FIRST_ACCOUNT, 7_000_000n, WALLET));
    const body = await feed.read();
    expect(body.stale).toBe(false);
    expect(body.stats).toMatchObject({ paid_jobs_7d: 2, workers_7d: 2, paid_7d: [{ token: "SOL", amount: "0.012" }] });
    expect(body.top_workers.map(({ wallet }) => wallet).sort()).toEqual([ORPHAN_ACCOUNT, WALLET].sort());
  });

  it("falls back to the announcing worker with the whole amount when a split's claim does not match its event", async () => {
    const { node, feed } = rig();
    node.add(splitRelease(THREE, 900_000_000n, { recipients: 2 }));
    const body = await feed.read();
    expect(body.stats).toMatchObject({ paid_jobs_7d: 1, workers_7d: 1, paid_7d: [{ token: "SOL", amount: "0.9" }] });
    expect(body.top_workers).toEqual([{ wallet: ALICE, paid_jobs: 1, paid_sol: "0.9", house: false }]);
  });
});

describe("state saved by an earlier version", () => {
  const releases = Array.from({ length: 12 }, (_, i) => {
    const k = i + 1;
    const account = addressOf(190 + k);
    const owner = k % 2 === 0 ? WALLET : ALICE;
    return {
      account,
      tx: {
        signature: signatureOf(200 + k),
        slot: 20_000 - k,
        blockTime: nowSecs(-k * 5 * HOUR_SECS),
        events: [released(addressOf(170 + k), WORKER, JUDGE), attested(addressOf(170 + k), OWNER, account, JUDGE, 1_000_000n)],
        holdings: [{ account, mint: NATIVE_MINT, owner }],
      } satisfies Tx,
    };
  });

  const earlier = (): Record<string, unknown> => ({
    ...emptyState(),
    version: 1,
    backfilled: true,
    newest: releases[0]?.tx.signature ?? null,
    paid: releases.map(({ account, tx: { signature, slot, blockTime } }) => ({
      at: new Date(blockTime * 1000).toISOString(),
      slot,
      signature,
      intent: addressOf(170),
      payee: account,
      token: "SOL",
      raw: "1000000",
      decimals: 9,
      house: false,
    })),
  });

  it("is ignored under the old key or with the old version, and a fresh backfill names wallets", async () => {
    expect(STATE_KEY).not.toBe("live-feed-state-v1");
    for (const key of ["live-feed-state-v1", STATE_KEY]) {
      const { node, cache, feed, tick } = rig({ limits: { signaturePage: 5, transactionsPerRefresh: 6 } });
      cache.values.set(key, JSON.stringify(earlier()));
      node.add(...[...releases].reverse().map(({ tx: release }) => release));
      const seen = await untilComplete(feed, tick, 20);
      expect(seen[0]?.history.complete).toBe(false);
      const body = seen.at(-1);
      expect(body?.history.complete).toBe(true);
      expect(body?.stats).toMatchObject({ paid_jobs_7d: 12, workers_7d: 2, paid_7d: [{ token: "SOL", amount: "0.012" }] });
      expect(body?.top_workers.map(({ wallet, paid_jobs }) => [wallet, paid_jobs])).toEqual([
        [ALICE, 6],
        [WALLET, 6],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))));
      expect(body?.events.every(({ payee }) => payee === undefined || payee === ALICE || payee === WALLET)).toBe(true);
    }
  });
});
