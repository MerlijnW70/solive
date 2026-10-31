import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { type Address, getAddressEncoder } from "@solana/kit";
import { attestedResult, CLAIMS_OPEN, encodeParams, getIntentEncoder, getIntentSize, INTENT_DISCRIMINATOR, IntentStatus, Kind } from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";
import {
  backoff,
  base58,
  type Cli,
  CLUSTERS,
  type Demo,
  demoFilters,
  demoRound,
  emptyLedger,
  type Event,
  fastRound,
  fastWork,
  type Found,
  notified,
  type Socket,
  watch,
  WATCH_RETRY_MS,
  watchOnce,
  wsUrlOf,
  INTENT_SIZE,
  INTENT_TAG,
  intentJob,
  loadDemos,
  MAX_BACKOFF_MS,
  MAX_FAILURES,
  programOf,
  programReader,
  type Rpc,
  rpcOf,
  rpcUrlOf,
  serialized,
  type Settings,
  tick,
} from "../../../scripts/demo-worker.mjs";
import { DEMO_BASE_URL } from "../src/agent/mcp.js";
import { CLUSTERS as CLI_CLUSTERS } from "../src/clusters.js";

const DEMO_DIR = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo");
const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
const WORKER = "Worker1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const KEY = "11111111111111111111111111111111" as Address;
const OWNER = "CMbTKrcjd6kVd2VDMUzN6qkMoxsRSDgGHvjFKxB5n9iy" as Address;
const NOW = 1_800_000_000;
const SETTINGS: Settings = { keypair: "/tmp/demo-worker.json", wallet: WORKER, maxStake: 50_000_000n, claimSecs: 900 };

type Escrow = { pubkey: string; specHash: string; nonce?: bigint; kind?: number; status?: number; claims?: number; expiresAt?: number };

function intentData({ specHash, nonce = 7n, kind = Kind.AttestedResult, status = IntentStatus.Open, claims = 0, expiresAt = NOW + 86_400 }: Escrow): Uint8Array {
  const params = encodeParams(attestedResult({ amountIn: 10_000_000n, minResult: 1n, maxResult: 1n, attestor: OWNER, specHash: Uint8Array.from(Buffer.from(specHash, "hex")), judgeFee: 0n }));
  return Uint8Array.from(
    getIntentEncoder().encode({
      owner: OWNER,
      inputMint: KEY,
      outputMint: KEY,
      receiver: OWNER,
      nonce,
      escrowed: 10_000_000n,
      createdAt: NOW - 10,
      expiresAt,
      kind,
      status,
      bump: 255,
      vaultBump: 254,
      version: 1,
      held: 0,
      flags: 0,
      params,
      rentPayer: OWNER,
      filled: 0n,
      revision: 0,
      partnerBps: 0,
      partnerCutBps: 0,
      inFlight: 0n,
      partner: KEY,
      bounty: 0,
      mandate: KEY,
      feeBps: 0,
      gap: new Uint8Array(2),
      mandateSerial: 0n,
      agentFee: 0n,
      claims,
      gap2: new Uint8Array(7),
      capped: 0n,
    }),
  );
}

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string; encoding: string } };

const passes = (data: Uint8Array, filters: Filter[]) =>
  filters.every(({ dataSize, memcmp }) => {
    if (dataSize !== undefined) {
      return data.length === dataSize;
    }
    const wanted = Buffer.from(memcmp?.bytes ?? "", "base64");
    return memcmp?.encoding === "base64" && wanted.every((byte, i) => data[(memcmp?.offset ?? 0) + i] === byte);
  });

function chain(escrows: () => Escrow[], options: { fail?: number; ignoreFilters?: boolean } = {}): { rpc: Rpc; reads: number } {
  const state = { rpc: undefined as unknown as Rpc, reads: 0 };
  let failures = options.fail ?? 0;
  state.rpc = async (method, params) => {
    state.reads += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error("getProgramAccounts failed: the node answered 429");
    }
    const [program, config] = params as [string, { encoding: string; filters: Filter[] }];
    expect([method, program, config.encoding]).toEqual(["getProgramAccounts", PROGRAM, "base64"]);
    return escrows()
      .map((escrow) => ({ escrow, data: intentData(escrow) }))
      .filter(({ data }) => options.ignoreFilters === true || passes(data, config.filters))
      .map(({ escrow, data }) => ({ pubkey: escrow.pubkey, account: { owner: PROGRAM, data: [Buffer.from(data).toString("base64"), "base64"] } }));
  };
  return state;
}

const notification = (escrow: Escrow) => ({
  jsonrpc: "2.0",
  method: "programNotification",
  params: { subscription: 41, result: { context: { slot: 1 }, value: { pubkey: escrow.pubkey, account: { owner: PROGRAM, data: [Buffer.from(intentData(escrow)).toString("base64"), "base64"] } } } },
});

class FakeSocket implements Socket {
  sent: string[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(script?: (socket: FakeSocket) => void) {
    if (script !== undefined) {
      setTimeout(() => script(this), 0);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close");
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown = undefined): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  message(value: unknown): void {
    this.emit("message", typeof value === "string" ? value : JSON.stringify(value));
  }
}

type Board = { state?: string; worker?: string | null; waiting?: number; stake?: string };

function cliStub(listed: () => object[] = () => [], board: Board = {}): { cli: Cli; calls: string[][] } {
  const calls: string[][] = [];
  const cli: Cli = async (args) => {
    calls.push([...args]);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    switch (args[0] === "claims" ? `claims ${args[1]}` : args[0]) {
      case "jobs":
        return { jobs: listed() };
      case "claims show":
        return { state: board.state ?? "free", worker: board.worker ?? null, stake: board.stake ?? "1000000", max_secs: 3600, line: { head: 0, tail: 0, waiting: board.waiting ?? 0 } };
      case "claims take":
        return { sent: true, signature: `claim-${at("--nonce")}` };
      case "deliver":
        return { sent: true, signature: `announce-${at("--intent")}` };
      default:
        throw new Error(`unexpected command ${args.join(" ")}`);
    }
  };
  return { cli, calls };
}

const verbs = (calls: string[][]) => calls.map((args) => (args[0] === "claims" ? `claims ${args[1]}` : (args[0] ?? "")));
const shown = (events: Event[]) => events.map(({ intent, action }) => `${action} ${intent}`);

describe("the demo worker's fast path", () => {
  it("reads the intent layout the program writes and the clusters the command line knows", () => {
    expect(INTENT_SIZE).toBe(getIntentSize());
    expect([...INTENT_TAG]).toEqual([...INTENT_DISCRIMINATOR]);
    expect(CLUSTERS).toEqual(CLI_CLUSTERS);
    expect(rpcUrlOf("devnet")).toBe(CLI_CLUSTERS["devnet"]);
    expect(rpcUrlOf("http://127.0.0.1:9999")).toBe("http://127.0.0.1:9999");
    expect(base58(getAddressEncoder().encode(OWNER) as Uint8Array)).toBe(OWNER);
    expect(base58(new Uint8Array(32))).toBe(KEY);
    const hash = "ab".repeat(32);
    expect(intentJob("I", intentData({ pubkey: "I", specHash: hash, nonce: 2n ** 40n, claims: CLAIMS_OPEN }), NOW)).toEqual({
      intent: "I",
      owner: OWNER,
      nonce: String(2n ** 40n),
      specHash: hash,
      takesClaims: true,
      claimedBy: null,
      waiting: 0,
      expiresAt: NOW + 86_400,
    });
    expect(intentJob("I", intentData({ pubkey: "I", specHash: hash, expiresAt: NOW }), NOW)).toBeNull();
    expect(intentJob("I", intentData({ pubkey: "I", specHash: hash, status: IntentStatus.Cancelled }), NOW)).toBeNull();
    expect(intentJob("I", intentData({ pubkey: "I", specHash: hash, kind: Kind.LimitOrder }), NOW)).toBeNull();
    expect(intentJob("I", intentData({ pubkey: "I", specHash: hash }).subarray(1), NOW)).toBeNull();
  });

  it("delivers a new demo escrow it reads by spec hash once, claims those that take claims, and ignores non-demo escrows", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const [fizz, palindrome, reverse] = demos as [Demo, Demo, Demo];
    const escrows: Escrow[] = [
      { pubkey: "fizz-escrow", specHash: fizz.specHash, nonce: 3n },
      { pubkey: "claimable-escrow", specHash: palindrome.specHash, nonce: 4n, claims: CLAIMS_OPEN },
      { pubkey: "cancelled-demo", specHash: reverse.specHash, status: IntentStatus.Cancelled },
      { pubkey: "expired-demo", specHash: reverse.specHash, expiresAt: NOW - 1 },
      { pubkey: "not-a-demo", specHash: "cd".repeat(32) },
    ];
    const { rpc } = chain(() => escrows);
    const { cli, calls } = cliStub();
    const ledger = emptyLedger();
    const read = programReader(rpc, PROGRAM);
    expect(shown(await fastRound(cli, read, demos, SETTINGS, ledger, NOW))).toEqual(["delivered fizz-escrow", "claimed claimable-escrow", "delivered claimable-escrow"]);
    expect(verbs(calls)).toEqual(["deliver", "claims show", "claims take", "deliver"]);
    const take = calls.find((args) => args[1] === "take") ?? [];
    expect([take[take.indexOf("--owner") + 1], take[take.indexOf("--nonce") + 1]]).toEqual([OWNER, "4"]);
    const delivered = calls.filter(([verb]) => verb === "deliver");
    expect(delivered.map((args) => args[args.indexOf("--artifact") + 1])).toEqual([fizz.solution, palindrome.solution]);
    calls.length = 0;
    expect(await fastRound(cli, read, demos, SETTINGS, ledger, NOW + 2)).toEqual([]);
    expect(calls).toEqual([]);
    expect([...ledger.done].sort()).toEqual(["claimable-escrow", "fizz-escrow"]);

    const unfiltered = programReader(chain(() => [{ pubkey: "slipped-through", specHash: "ef".repeat(32) }], { ignoreFilters: true }).rpc, PROGRAM);
    const quiet = cliStub();
    expect(await fastRound(quiet.cli, unfiltered, demos, SETTINGS, emptyLedger(), NOW)).toEqual([]);
    expect(quiet.calls).toEqual([]);
  });

  it(`retries a failed delivery in its next round and gives up after ${MAX_FAILURES} failures`, async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const read = programReader(chain(() => [{ pubkey: "busy-node", specHash: (demos[0] as Demo).specHash }, { pubkey: "down-node", specHash: (demos[1] as Demo).specHash }]).rpc, PROGRAM);
    const { cli: answers, calls } = cliStub();
    let busy = 1;
    const cli: Cli = async (args) => {
      const intent = args[args.indexOf("--intent") + 1];
      if (args[0] === "deliver" && (intent === "down-node" || (intent === "busy-node" && busy-- > 0))) {
        calls.push([...args]);
        throw new Error("deliver --keypair failed: HTTP error (429): Too Many Requests");
      }
      return answers(args);
    };
    const ledger = emptyLedger();
    const rounds: string[][] = [];
    for (let round = 0; round <= MAX_FAILURES; round += 1) {
      rounds.push(shown(await fastRound(cli, read, demos, SETTINGS, ledger, NOW)));
    }
    expect(rounds).toEqual([["failed busy-node", "failed down-node"], ["delivered busy-node", "failed down-node"], ["gave-up down-node"], []]);
    expect(calls.filter(([verb]) => verb === "deliver")).toHaveLength(2 + MAX_FAILURES);
  });

  it("leaves an escrow another worker holds to the full scan and says so once", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const read = programReader(chain(() => [{ pubkey: "held", specHash: (demos[0] as Demo).specHash, claims: CLAIMS_OPEN }]).rpc, PROGRAM);
    const ledger = emptyLedger();
    for (const board of [{ state: "held", worker: OTHER }, { waiting: 1 }]) {
      const { cli, calls } = cliStub(() => [], board);
      const fresh = emptyLedger();
      expect((await fastRound(cli, read, demos, SETTINGS, fresh, NOW)).map(({ action }) => action)).toEqual(["skipped"]);
      expect(await fastRound(cli, read, demos, SETTINGS, fresh, NOW)).toEqual([]);
      expect(verbs(calls)).toEqual(["claims show"]);
    }
    const mine = cliStub(() => [], { state: "held", worker: WORKER });
    expect(shown(await fastRound(mine.cli, read, demos, SETTINGS, ledger, NOW))).toEqual(["delivered held"]);
    expect(verbs(mine.calls)).toEqual(["claims show", "deliver"]);
  });

  it("lets the full scan find a demo escrow the fast path missed, and the fast path then leaves it alone", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const hash = (demos[1] as Demo).specHash;
    const missed = { pubkey: "missed", specHash: hash };
    let visible: Escrow[] = [];
    const read = programReader(chain(() => visible).rpc, PROGRAM);
    const listing = [{ intent: "missed", owner: OWNER, nonce: "7", specHash: hash, expiresAt: String(NOW + 86_400), takes_claims: false, claimed_by: null, waiting: 0 }];
    const { cli, calls } = cliStub(() => listing);
    const ledger = emptyLedger();
    expect(await fastRound(cli, read, demos, SETTINGS, ledger, NOW)).toEqual([]);
    expect(shown(await demoRound(cli, demos, SETTINGS, ledger, NOW))).toEqual(["delivered missed"]);
    visible = [missed];
    expect(await fastRound(cli, read, demos, SETTINGS, ledger, NOW)).toEqual([]);
    expect(verbs(calls)).toEqual(["jobs", "deliver"]);
  });

  it("recovers after a failed read: the round logs the failure, backs off, and the next round delivers", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const node = chain(() => [{ pubkey: "late", specHash: (demos[2] as Demo).specHash }], { fail: 1 });
    const read = programReader(node.rpc, PROGRAM);
    const { cli } = cliStub();
    const ledger = emptyLedger();
    const out: string[] = [];
    const err: string[] = [];
    const at = () => new Date(NOW * 1000);
    const round = () => fastRound(cli, read, demos, SETTINGS, ledger, NOW);
    expect(await tick("fast", round, { out: (line) => out.push(line), err: (line) => err.push(line) }, at)).toBe(false);
    expect(err.map((line) => JSON.parse(line))).toEqual([{ at: at().toISOString(), round: "failed", path: "fast", detail: "getProgramAccounts failed: the node answered 429" }]);
    expect(await tick("fast", round, { out: (line) => out.push(line), err: (line) => err.push(line) }, at)).toBe(true);
    expect(out.map((line) => JSON.parse(line))).toEqual([{ at: at().toISOString(), intent: "late", demo: (demos[2] as Demo).name, action: "delivered", detail: "announce-late" }]);
    expect(node.reads).toBe(2 * demos.length);
    expect([0, 1, 2, 30].map((failures) => backoff(2000, failures))).toEqual([2000, 4000, 8000, MAX_BACKOFF_MS]);
    expect(backoff(300_000, 3)).toBe(300_000);
  });

  it("turns node answers into results or errors and finds the program from the config account", async () => {
    const answers: unknown[] = [{ ok: true, body: { jsonrpc: "2.0", id: 1, result: { value: { owner: PROGRAM } } } }, { ok: true, body: { error: { code: -32005, message: "busy" } } }, { ok: false, status: 503, body: {} }];
    const sent: unknown[] = [];
    const fetcher = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      const answer = answers.shift() as { ok: boolean; status?: number; body: object };
      return { ok: answer.ok, status: answer.status ?? 200, json: async () => answer.body };
    }) as unknown as typeof fetch;
    const rpc = rpcOf("http://127.0.0.1:8899", fetcher);
    const config = cliStub();
    const show: Cli = async (args) => (args.join(" ") === "show config" ? { address: "Config1111111111111111111111111111111111111" } : config.cli(args));
    expect(await programOf(show, rpc)).toBe(PROGRAM);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["Config1111111111111111111111111111111111111", { encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }]);
    await expect(rpc("getProgramAccounts", [])).rejects.toThrow('getProgramAccounts failed: {"code":-32005,"message":"busy"}');
    await expect(rpc("getProgramAccounts", [])).rejects.toThrow("getProgramAccounts failed: the node answered 503");
  });

  it("subscribes to new escrows of each demo spec and hands on only demo escrows from its notifications", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const socket = new FakeSocket();
    const seen: string[] = [];
    const closed = watchOnce(() => socket, "wss://node", PROGRAM, demos, () => NOW, ({ demo, job }) => seen.push(`${demo.name} ${job.intent}`));
    socket.emit("open");
    expect(socket.sent.map((text) => JSON.parse(text))).toEqual(demos.map((demo, at) => ({ jsonrpc: "2.0", id: at + 1, method: "programSubscribe", params: [PROGRAM, { encoding: "base64", commitment: "confirmed", filters: demoFilters(demo.specHash) }] })));
    socket.message({ jsonrpc: "2.0", id: 1, result: 41 });
    socket.message(notification({ pubkey: "watched", specHash: (demos[1] as Demo).specHash }));
    socket.message(notification({ pubkey: "not-a-demo", specHash: "cd".repeat(32) }));
    socket.message(notification({ pubkey: "cancelled", specHash: (demos[1] as Demo).specHash, status: IntentStatus.Cancelled }));
    socket.message("not json");
    socket.emit("error");
    expect(await closed).toBe("the subscription closed");
    expect(seen).toEqual([`${(demos[1] as Demo).name} watched`]);
    expect(notified({ method: "accountNotification", params: notification({ pubkey: "x", specHash: (demos[0] as Demo).specHash }).params }, demos, NOW)).toEqual([]);
  });

  it("reconnects a dropped or refused subscription and keeps delivering what it then sees", async () => {
    const demos = await loadDemos(DEMO_DIR, DEMO_BASE_URL);
    const hash = (demos[0] as Demo).specHash;
    const opens: (() => FakeSocket)[] = [
      () => {
        throw new Error("connect ECONNREFUSED");
      },
      () =>
        new FakeSocket((socket) => {
          socket.emit("open");
          socket.message({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
        }),
      () =>
        new FakeSocket((socket) => {
          socket.emit("open");
          socket.message(notification({ pubkey: "after-reconnect", specHash: hash }));
          socket.message(notification({ pubkey: "after-reconnect", specHash: hash }));
        }),
    ];
    const { cli, calls } = cliStub();
    const ledger = emptyLedger();
    const lock = serialized();
    const events: Event[] = [];
    const err: string[] = [];
    const waits: number[] = [];
    let rounds = 0;
    await new Promise<void>((done) => {
      const seen = (found: Found) =>
        void lock(() => fastWork(cli, [found], SETTINGS, ledger, NOW)).then((more) => {
          events.push(...more);
          rounds += 1;
          if (rounds === 2) {
            done();
          }
        });
      const log = { out: () => undefined, err: (line: string) => err.push(line) };
      void watch(() => (opens.shift() as () => FakeSocket)(), "wss://node", PROGRAM, demos, () => NOW, seen, log, async (ms) => waits.push(ms), () => opens.length > 0);
    });
    expect(err.map((line) => JSON.parse(line).detail)).toEqual(["connect ECONNREFUSED", 'programSubscribe failed: {"code":-32601,"message":"Method not found"}']);
    expect(waits).toEqual([backoff(WATCH_RETRY_MS, 1), backoff(WATCH_RETRY_MS, 2)]);
    expect(shown(events)).toEqual(["delivered after-reconnect"]);
    expect(verbs(calls)).toEqual(["deliver"]);
    expect(wsUrlOf("devnet")).toBe("wss://api.devnet.solana.com/");
    expect(wsUrlOf("localnet")).toBe("ws://127.0.0.1:8900/");
  });

  it("runs one round at a time so the fast path and the full scan never work the same escrow together", async () => {
    const lock = serialized();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name} start`);
      await new Promise((done) => setTimeout(done, ms));
      order.push(`${name} end`);
      return name;
    };
    const failing = lock(async () => {
      throw new Error("round failed");
    });
    expect(await Promise.all([lock(task("full", 20)), lock(task("fast", 1)), failing.catch((error: Error) => error.message), lock(task("next", 1))])).toEqual(["full", "fast", "round failed", "next"]);
    expect(order).toEqual(["full start", "full end", "fast start", "fast end", "next start", "next end"]);
  });
});
