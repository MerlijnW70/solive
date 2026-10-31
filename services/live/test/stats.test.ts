import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { DEMO_SPECS, specName } from "../src/catalog.js";
import { createHandler } from "../src/http.js";
import { CACHE_CONTROL, CDN_CACHE_CONTROL, DRIP_LAMPORTS, SERVICE_WINDOW_SECS } from "../src/limits.js";
import {
  addressOf,
  announced,
  attested,
  claimed,
  createAccounts,
  createCall,
  created,
  CUSTOM_HASH,
  FIZZBUZZ_HASH,
  HOUSE_WALLET,
  intentData,
  JUDGE,
  OWNER,
  released,
  signatureOf,
  type Tx,
  WORKER,
} from "./chain.js";
import { HOUR_SECS, nowSecs, rig } from "./harness.js";

const SELF = addressOf(21);
const OUTSIDE = addressOf(22);
const HOUSED = addressOf(23);
const OLD = addressOf(24);
const TESTED = addressOf(25);
const OTHER_WORKER = addressOf(26);

let n = 0;
const tx = (events: Uint8Array[], extra: Partial<Tx> = {}, age = HOUR_SECS): Tx => {
  n += 1;
  return { signature: signatureOf(150 + n), slot: 5000 + n, blockTime: nowSecs(-age + n), events, ...extra };
};

const escrow = (intent: ReturnType<typeof addressOf>, owner: ReturnType<typeof addressOf>, judge: ReturnType<typeof addressOf>, amount: bigint, mint = NATIVE_MINT, age = HOUR_SECS) =>
  tx([created(intent, owner, amount, mint)], { calls: [{ data: createCall(judge, CUSTOM_HASH, amount), accounts: createAccounts(owner, intent) }] }, age);

const pay = (intent: ReturnType<typeof addressOf>, owner: ReturnType<typeof addressOf>, worker: ReturnType<typeof addressOf>, judge: ReturnType<typeof addressOf>, net: bigint, age = HOUR_SECS) =>
  tx([released(intent, worker, judge), attested(intent, owner, worker, judge, net)], {}, age);

function market(): Tx[] {
  const week = 7 * 24 * HOUR_SECS;
  return [
    escrow(OLD, OWNER, JUDGE, 900_000_000n, NATIVE_MINT, week + 2 * HOUR_SECS),
    pay(OLD, OWNER, WORKER, JUDGE, 900_000_000n, week + HOUR_SECS),
    escrow(SELF, OWNER, OWNER, 100_000_000n),
    tx([announced(SELF, WORKER, OWNER)]),
    pay(SELF, OWNER, WORKER, OWNER, 100_000_000n),
    escrow(OUTSIDE, OWNER, JUDGE, 50_000_000n),
    pay(OUTSIDE, OWNER, WORKER, JUDGE, 50_000_000n),
    escrow(HOUSED, OWNER, JUDGE, 20_000_000n),
    tx([claimed(HOUSED, HOUSE_WALLET, 0n)]),
    pay(HOUSED, OWNER, HOUSE_WALLET, JUDGE, 20_000_000n),
    escrow(TESTED, OWNER, JUDGE, 2_500_000n, DEVNET_TEST_MINT),
    pay(TESTED, OWNER, OTHER_WORKER, JUDGE, 2_500_000n),
  ];
}

describe("house and totals", () => {
  it("marks house activity by FEED_HOUSE and by self-judged escrows", async () => {
    const { node, feed } = rig({ env: { FEED_HOUSE: `${HOUSE_WALLET}, not-an-address` } });
    node.add(...market());
    const body = await feed.read();
    const of = (intent: string) => body.events.filter((event) => event.intent === intent).map(({ kind, house }) => [kind, house]);
    expect(of(SELF)).toEqual([["release", true], ["delivery", true], ["escrow", true]]);
    expect(of(OUTSIDE)).toEqual([["release", false], ["escrow", false]]);
    expect(of(HOUSED)).toEqual([["release", true], ["claim", true], ["escrow", false]]);
    expect(body.stats.house_paid_jobs_7d).toBe(2);
    expect(body.top_workers).toEqual([
      { wallet: WORKER, paid_jobs: 2, paid_sol: "0.15", house: false },
      { wallet: HOUSE_WALLET, paid_jobs: 1, paid_sol: "0.02", house: true },
      { wallet: OTHER_WORKER, paid_jobs: 1, paid_sol: "0", house: false },
    ]);
  });

  it("marks a top worker house when every job it was paid for in the window was house", async () => {
    const { node, feed } = rig();
    node.add(escrow(SELF, OWNER, OWNER, 10_000_000n), pay(SELF, OWNER, OTHER_WORKER, OWNER, 10_000_000n), escrow(OUTSIDE, OWNER, JUDGE, 10_000_000n), pay(OUTSIDE, OWNER, WORKER, JUDGE, 10_000_000n));
    const body = await feed.read();
    expect(Object.fromEntries(body.top_workers.map(({ wallet, house }) => [wallet, house]))).toEqual({ [OTHER_WORKER]: true, [WORKER]: false });
  });

  it("totals paid amounts per token over the last 7 days only", async () => {
    const { node, feed } = rig();
    node.add(...market());
    const body = await feed.read();
    expect(body.stats).toMatchObject({
      paid_jobs_7d: 4,
      workers_7d: 3,
      paid_7d: [
        { token: "SOL", amount: "0.17" },
        { token: "TEST", amount: "2.5" },
      ],
    });
    expect(body.events.some(({ intent, kind }) => intent === OLD && kind === "release")).toBe(true);
  });

  it("counts open, unexpired proof escrows as open jobs", async () => {
    const { node, feed } = rig();
    node.intents = [
      { pubkey: addressOf(31), data: intentData(OWNER, JUDGE, FIZZBUZZ_HASH, 1_000_000n) },
      { pubkey: addressOf(32), data: intentData(OWNER, JUDGE, CUSTOM_HASH, 2_000_000n) },
    ];
    const body = await feed.read();
    expect(body.stats.open_jobs).toBe(2);
  });
});

describe("services", () => {
  const env = { FEED_FAUCET: addressOf(41), FEED_DEMO_WORKER: addressOf(42), FEED_FILLER: addressOf(43) };

  it("reads unknown when a wallet is unset", async () => {
    const { feed, probes } = rig();
    const body = await feed.read();
    expect(body.services).toEqual({ faucet: "unknown", demo_worker: "unknown", filler: "unknown" });
    expect(probes).toBe(0);
  });

  it("maps recent wallet activity, the faucet's 405 and its balance to up and down", async () => {
    const up = rig({ env });
    up.node.lamports.set(addressOf(41), Number(DRIP_LAMPORTS));
    up.node.wallets.set(addressOf(42), [{ signature: signatureOf(201), slot: 1, blockTime: nowSecs(-SERVICE_WINDOW_SECS + 5), err: null, memo: null }]);
    up.node.wallets.set(addressOf(43), [{ signature: signatureOf(202), slot: 1, blockTime: nowSecs(-SERVICE_WINDOW_SECS - 5), err: null, memo: null }]);
    expect((await up.feed.read()).services).toEqual({ faucet: "up", demo_worker: "up", filler: "down" });
    const poor = rig({ env });
    poor.node.lamports.set(addressOf(41), Number(DRIP_LAMPORTS) - 1);
    expect((await poor.feed.read()).services).toEqual({ faucet: "down", demo_worker: "down", filler: "down" });
    const open = rig({ env, probe: async () => 200 });
    open.node.lamports.set(addressOf(41), Number(DRIP_LAMPORTS));
    expect((await open.feed.read()).services.faucet).toBe("down");
    const dead = rig({
      env,
      probe: async () => {
        throw new Error("connect refused");
      },
    });
    dead.node.lamports.set(addressOf(41), Number(DRIP_LAMPORTS));
    expect((await dead.feed.read()).services.faucet).toBe("down");
  });
});

describe("catalog", () => {
  it("names exactly the demo specs in examples/demo by the sha256 of their SPEC.md", () => {
    const root = join(import.meta.dirname, "..", "..", "..", "examples", "demo");
    const found = Object.fromEntries(
      readdirSync(root)
        .sort()
        .map((name) => [createHash("sha256").update(readFileSync(join(root, name, "SPEC.md"))).digest("hex"), name]),
    );
    expect(DEMO_SPECS).toEqual(found);
    expect(specName(FIZZBUZZ_HASH)).toBe("fizzbuzz");
    expect(specName(CUSTOM_HASH)).toBeNull();
    expect(specName("constructor")).toBeNull();
    expect(specName(null)).toBeNull();
  });
});

describe("http", () => {
  it("answers GET with the feed and both cache headers, and refuses other methods", async () => {
    const { feed } = rig();
    const server = createServer((req, res) => void createHandler(feed)(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const call = (method: string) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/feed", method }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      const got = await call("GET");
      expect(got.status).toBe(200);
      expect(got.headers["cache-control"]).toBe(CACHE_CONTROL);
      expect(got.headers["vercel-cdn-cache-control"]).toBe(CDN_CACHE_CONTROL);
      expect(CACHE_CONTROL).toBe("public, max-age=10");
      expect(CDN_CACHE_CONTROL).toBe("public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400");
      expect(Object.keys(JSON.parse(got.body)).sort()).toEqual(
        ["cluster", "generated_at", "program", "last_event_at", "stale", "stale_since", "stats", "events", "latest_paid_job", "top_workers", "services"].sort(),
      );
      const posted = await call("POST");
      expect(posted.status).toBe(405);
      expect(posted.headers["cache-control"]).toBe("no-store");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
