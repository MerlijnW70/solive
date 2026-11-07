import { describe, expect, it } from "vitest";
import { type Cli, type Demo, type DemoJob, type Found, type Settings, type Socket, worker } from "./demo-worker-module.js";

const {
  backoff,
  emptyLedger,
  FAST_INTERVAL_SECS,
  fastRound,
  KEEPALIVE,
  pollEvery,
  repeat,
  WATCH_RETRY_MS,
  WATCHED_INTERVAL_SECS,
  watch,
  watchOnce,
} = worker;

const PROGRAM = "Program11111111111111111111111111111111111111";
const NOW = 1_800_000_000;
const DEMO: Demo = { name: "fizzbuzz", specHash: "ab".repeat(32), solution: "solution.mjs", workUrl: "https://example.test/solution.mjs" };
const SETTINGS: Settings = { keypair: "k.json", wallet: "Worker1111111111111111111111111111111111111", maxStake: 50_000_000n, claimSecs: 900 };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class FakeSocket implements Socket {
  sent: string[] = [];
  closes = 0;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    private readonly closeEmitsError = false,
    script?: (socket: FakeSocket) => void,
  ) {
    if (script !== undefined) {
      setTimeout(() => script(this), 0);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closes += 1;
    if (this.closeEmitsError) {
      this.emit("error");
    }
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
}

const job = (intent: string): DemoJob => ({ intent, owner: "Owner", nonce: "1", specHash: DEMO.specHash, takesClaims: false, claimedBy: null, waiting: 0, expiresAt: NOW + 3600 });

function deliverer(): { cli: Cli; delivered: string[] } {
  const delivered: string[] = [];
  const cli: Cli = async (args) => {
    if (args[0] === "deliver") {
      delivered.push(String(args[args.indexOf("--intent") + 1]));
      return { sent: true, signature: "sig" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { cli, delivered };
}

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
};

describe("the demo worker's watch connection", () => {
  it("sends a keep-alive while the connection is open so the node's idle timeout never closes it, and stops at close", async () => {
    const socket = new FakeSocket();
    const closed = watchOnce(() => socket, "wss://node", PROGRAM, [DEMO], () => NOW, () => undefined, { keepAliveMs: 5, stableMs: 1_000 });
    socket.emit("open");
    await sleep(40);
    const beats = socket.sent.filter((text) => text === KEEPALIVE).length;
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(KEEPALIVE)).toEqual({ jsonrpc: "2.0", id: 0, method: "getVersion" });
    socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -1, message: "ignored" } }));
    expect(socket.closes).toBe(0);
    socket.close();
    expect(await closed).toBe("the subscription closed");
    const after = socket.sent.length;
    await sleep(30);
    expect(socket.sent.length).toBe(after);
  });

  it("closes a failing connection once even when closing raises another error event", async () => {
    const socket = new FakeSocket(true);
    const closed = watchOnce(() => socket, "wss://node", PROGRAM, [DEMO], () => NOW, () => undefined);
    socket.emit("error");
    expect(await closed).toBe("the subscription closed");
    expect(socket.closes).toBe(1);
  });

  it("reopens a subscription that closes, waiting longer after each close, and logs the same reason once", async () => {
    let opened = 0;
    const waits: number[] = [];
    const { err, log } = quiet();
    await watch(
      () => {
        opened += 1;
        return new FakeSocket(false, (socket) => socket.close());
      },
      "wss://node",
      PROGRAM,
      [DEMO],
      () => NOW,
      () => undefined,
      log,
      async (ms) => waits.push(ms),
      () => opened < 6,
    );
    expect(opened).toBe(6);
    expect(waits).toEqual([1, 2, 3, 4, 5, 6].map((failures) => backoff(WATCH_RETRY_MS, failures)));
    expect(waits[5]).toBeGreaterThan(waits[0] as number);
    expect(err.map((line) => JSON.parse(line).detail)).toEqual(["the subscription closed"]);
  });

  it("logs again after the subscription held, and says once when it is back", async () => {
    let opened = 0;
    const { out, err, log } = quiet();
    const states: string[] = [];
    await watch(
      () => {
        opened += 1;
        const holds = opened === 2;
        return new FakeSocket(false, (socket) => {
          socket.emit("open");
          setTimeout(() => socket.close(), holds ? 60 : 0);
        });
      },
      "wss://node",
      PROGRAM,
      [DEMO],
      () => NOW,
      () => undefined,
      log,
      async () => undefined,
      () => opened < 4,
      { stableMs: 20, keepAliveMs: 1_000, up: () => states.push("up"), down: () => states.push("down") },
    );
    expect(err.map((line) => JSON.parse(line).detail)).toEqual(["the subscription closed", "the subscription closed"]);
    expect(out.map((line) => JSON.parse(line).round)).toEqual(["recovered"]);
    expect(states).toEqual(["down", "up", "down", "down", "down"]);
  });
});

describe("polling while the subscription is closed", () => {
  it("polls at the fast rate while closed and slower while open, never faster than asked", () => {
    expect(pollEvery(() => false, FAST_INTERVAL_SECS * 1000, WATCHED_INTERVAL_SECS * 1000)).toBe(FAST_INTERVAL_SECS * 1000);
    expect(pollEvery(() => true, FAST_INTERVAL_SECS * 1000, WATCHED_INTERVAL_SECS * 1000)).toBe(WATCHED_INTERVAL_SECS * 1000);
    expect(pollEvery(() => true, 40_000, 10_000)).toBe(40_000);
  });

  it("finds a new demo escrow by polling while the watch is closed and delivers it once", async () => {
    const { cli, delivered } = deliverer();
    const ledger = emptyLedger();
    const listed: Found[][] = [[], [{ demo: DEMO, job: job("late") }], [{ demo: DEMO, job: job("late") }], [{ demo: DEMO, job: job("late") }]];
    const read = async () => listed.shift() ?? [];
    const waits: number[] = [];
    const { out, err, log } = quiet();
    let rounds = 0;
    await repeat(
      "fast",
      async () => {
        rounds += 1;
        return fastRound(cli, read, [DEMO], SETTINGS, ledger, NOW);
      },
      () => pollEvery(() => false, 15_000, 30_000),
      log,
      async (ms) => waits.push(ms),
      () => rounds < 4,
    );
    expect(delivered).toEqual(["late"]);
    expect(waits).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(out.map((line) => JSON.parse(line).action)).toEqual(["delivered"]);
    expect(err).toEqual([]);
  });

  it("does not deliver again an escrow the watch already delivered", async () => {
    const { cli, delivered } = deliverer();
    const ledger = emptyLedger();
    const found = [{ demo: DEMO, job: job("both") }];
    await fastRound(cli, async () => found, [DEMO], SETTINGS, ledger, NOW);
    await fastRound(cli, async () => found, [DEMO], SETTINGS, ledger, NOW);
    expect(delivered).toEqual(["both"]);
  });

  it("logs a polling round that really fails as failed", async () => {
    const { cli } = deliverer();
    const { err, log } = quiet();
    let rounds = 0;
    await repeat(
      "fast",
      async () => {
        rounds += 1;
        return fastRound(cli, async () => Promise.reject(new Error("getProgramAccounts failed: the node answered 429")), [DEMO], SETTINGS, emptyLedger(), NOW);
      },
      () => 1_000,
      log,
      async () => undefined,
      () => rounds < 2,
    );
    expect(err.map((line) => JSON.parse(line))).toMatchObject([{ round: "failed", path: "fast" }, { round: "failed", path: "fast" }]);
  });
});
