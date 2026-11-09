import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { worker } from "./demo-worker-module.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const { backoff, BUSY_HOLD_MS, gateOf, jittered, MAX_RETRY_AFTER_MS, pollEvery, repeat, retryAfterMs, rpcOf, tick } = worker;
const T0 = 1_800_000_000_000;

const temp: string[] = [];
afterAll(async () => {
  await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "demo-node-"));
  temp.push(dir);
  return dir;
};

type Answer = { status: number; retryAfter?: string; body?: object };

function node(answers: Answer[]) {
  const sent: string[] = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).method);
    const answer = answers.shift() ?? { status: 200, body: { result: [] } };
    const headers = new Headers(answer.retryAfter === undefined ? {} : { "retry-after": answer.retryAfter });
    return { ok: answer.status < 300, status: answer.status, headers, json: async () => answer.body ?? {} };
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

function clocked() {
  const state = { now: T0, slept: [] as number[] };
  const clock = () => state.now;
  const sleep = async (ms: number) => {
    state.slept.push(ms);
    state.now += ms;
  };
  return { state, clock, sleep };
}

describe("the demo worker on a busy node", () => {
  it("reads Retry-After as seconds or a date, and caps it", () => {
    expect(retryAfterMs("7", T0)).toBe(7_000);
    expect(retryAfterMs(new Date(T0 + 12_000).toUTCString(), T0)).toBe(12_000);
    expect(retryAfterMs("999999", T0)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs(new Date(T0 - 5_000).toUTCString(), T0)).toBe(0);
    expect(retryAfterMs(null, T0)).toBeNull();
    expect(retryAfterMs("soon", T0)).toBeNull();
  });

  it("honours Retry-After on a 429: no request reaches the node again before it ends", async () => {
    const { state, clock, sleep } = clocked();
    const gate = gateOf(clock, sleep);
    const { fetcher, sent } = node([{ status: 429, retryAfter: "7" }, { status: 200, body: { result: { value: 5 } } }]);
    const rpc = rpcOf("http://node", fetcher, gate, clock);
    await expect(rpc("getProgramAccounts", [])).rejects.toThrow("getProgramAccounts failed: the node answered 429; this worker waits 7 seconds, as its Retry-After asks");
    expect(gate.until()).toBe(T0 + 7_000);
    expect(await rpc("getBalance", [])).toEqual({ value: 5 });
    expect(state.slept).toEqual([7_000]);
    expect(sent).toEqual(["getProgramAccounts", "getBalance"]);
  });

  it("waits its own hold on a 429 without Retry-After", async () => {
    const { clock, sleep } = clocked();
    const gate = gateOf(clock, sleep);
    const rpc = rpcOf("http://node", node([{ status: 429 }]).fetcher, gate, clock);
    await expect(rpc("getProgramAccounts", [])).rejects.toThrow(`waits ${BUSY_HOLD_MS / 1000} seconds`);
    expect(gate.until()).toBe(T0 + BUSY_HOLD_MS);
  });

  it("makes every loop wait out Retry-After, not only the one that met it", async () => {
    const { state, clock, sleep } = clocked();
    const gate = gateOf(clock, sleep);
    const rpc = rpcOf("http://node", node([{ status: 429, retryAfter: "40" }]).fetcher, gate, clock);
    const waits: number[] = [];
    const log = { out: () => undefined, err: () => undefined };
    let rounds = 0;
    await repeat(
      "fast",
      async () => {
        rounds += 1;
        await rpc("getProgramAccounts", []);
        return [];
      },
      () => 1_000,
      log,
      async (ms) => waits.push(ms),
      () => rounds < 1,
      { gate, random: () => 0, clock },
    );
    let other = 0;
    await repeat(
      "full",
      async () => {
        other += 1;
        return [];
      },
      () => 5_000,
      log,
      async (ms) => waits.push(ms),
      () => other < 1,
      { gate, random: () => 0, clock },
    );
    expect(waits).toEqual([40_000, 40_000]);
    expect(state.now).toBe(T0);
  });

  it("holds every loop after a 429 the command line met, which carries no Retry-After", async () => {
    const { clock, sleep } = clocked();
    const gate = gateOf(clock, sleep);
    const waits: number[] = [];
    let rounds = 0;
    await repeat(
      "full",
      async () => {
        rounds += 1;
        throw new Error("jobs failed: HTTP error (429): Too Many Requests");
      },
      () => 1_000,
      { out: () => undefined, err: () => undefined },
      async (ms) => waits.push(ms),
      () => rounds < 2,
      { gate, random: () => 0, clock },
    );
    expect(waits).toEqual([backoff(1_000, 1), backoff(1_000, 2)]);
    expect(gate.until()).toBe(T0 + backoff(1_000, 2));
  });

  it("backs off exponentially after failures, with jitter that never shortens a wait", async () => {
    expect([0, 0.5, 1].map((random) => jittered(8_000, () => random))).toEqual([8_000, 10_000, 12_000]);
    const waits: number[] = [];
    let rounds = 0;
    const randoms = [0.2, 0.9, 0.4];
    await repeat(
      "fast",
      async () => {
        rounds += 1;
        throw new Error("getProgramAccounts failed: the node answered 503");
      },
      () => 2_000,
      { out: () => undefined, err: () => undefined },
      async (ms) => waits.push(ms),
      () => rounds < 3,
      { random: () => randoms.shift() ?? 0 },
    );
    expect(waits).toEqual([jittered(4_000, () => 0.2), jittered(8_000, () => 0.9), jittered(16_000, () => 0.4)]);
    expect(waits.every((ms, at) => ms >= backoff(2_000, at + 1))).toBe(true);
  });

  it("polls more slowly while the subscription is up, and at the fast rate once it drops", async () => {
    const link = [false, true, true, false];
    let open = false;
    const waits: number[] = [];
    let rounds = 0;
    await repeat(
      "fast",
      async () => {
        open = link[rounds] ?? false;
        rounds += 1;
        return [];
      },
      () => pollEvery(() => open, 30_000, 120_000),
      { out: () => undefined, err: () => undefined },
      async (ms) => waits.push(ms),
      () => rounds < 4,
    );
    expect(waits).toEqual([30_000, 120_000, 120_000, 30_000]);
  });
});

describe("the demo worker's log", () => {
  it("writes one JSON line per event, with no NUL or other control byte, whatever the command line printed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    await tick("fast", async () => [{ intent: "I", demo: "fizzbuzz", action: "failed", detail: "deliver failed: \u0000\u0000\u001b[31mred\r\nnext" }], log);
    await tick("fast", async () => Promise.reject(new Error("jobs failed: \u0000binary\u0007")), log);
    for (const line of [...out, ...err]) {
      expect(line).not.toMatch(/[\u0000-\u001f]/);
      expect(JSON.parse(line)).toBeTypeOf("object");
    }
    expect(JSON.parse(out[0] as string).detail).toBe("deliver failed: \u0000\u0000\u001b[31mred\r\nnext");
  });

  it("removes the NUL run an unclean stop leaves in the log before the worker starts, and keeps every line", async () => {
    const dir = await scratch();
    const log = join(dir, "demo-worker.log");
    const lines = ['{"at":"1","action":"delivered"}', '{"at":"2","action":"delivered"}'];
    await writeFile(log, `${lines[0]}\n${"\u0000".repeat(4096)}\n${lines[1]}\n`);
    const said = execFileSync("bash", [join(ROOT, "scripts", "demo-worker-log.sh"), log], { encoding: "utf8" });
    expect(await readFile(log, "utf8")).toBe(`${lines[0]}\n\n${lines[1]}\n`);
    expect(JSON.parse(said).detail).toBe(`removed 4096 NUL bytes that an unclean stop left in ${log}`);
    expect(execFileSync("bash", [join(ROOT, "scripts", "demo-worker-log.sh"), log], { encoding: "utf8" })).toBe("");
    expect(execFileSync("bash", [join(ROOT, "scripts", "demo-worker-log.sh"), join(dir, "absent.log")], { encoding: "utf8" })).toBe("");
  });

  it("installs the unit the runbook shows and a logrotate stanza that bounds the log without losing the open file", async () => {
    const dir = await scratch();
    execFileSync("bash", [join(ROOT, "scripts", "demo-worker-install.sh")], { env: { ...process.env, DEMO_WORKER_INSTALL_ROOT: dir }, encoding: "utf8" });
    const unit = await readFile(join(dir, "etc/systemd/system/solive-demo-worker.service"), "utf8");
    expect(unit).toContain("\nExecStart=/bin/bash /home/dev/solive/scripts/demo-worker.sh\n");
    expect(unit).toContain("\nStandardOutput=append:/home/dev/demo-worker.log\n");
    expect(unit).toContain("\nExecStartPre=/bin/bash /home/dev/solive/scripts/demo-worker-log.sh /home/dev/demo-worker.log\n");
    const runbook = await readFile(join(ROOT, "docs/maintainers/operations.md"), "utf8");
    const shown = /```ini\n(\[Unit\]\nDescription=solive devnet demo worker\n[\s\S]*?)```/.exec(runbook)?.[1];
    expect(shown).toBe(unit);
    const rotate = await readFile(join(dir, "etc/logrotate.d/solive-demo-worker"), "utf8");
    expect(rotate.split("\n")[0]).toBe("/home/dev/demo-worker.log {");
    expect(rotate).toMatch(/^ {2}copytruncate$/m);
    expect(rotate).toMatch(/^ {2}size 10M$/m);
    expect(rotate).toMatch(/^ {2}rotate 5$/m);
    expect(runbook).toContain(rotate);
  });

  it.skipIf(process.getuid?.() === 0)("refuses to install into the system without root", () => {
    const env = { ...process.env, DEMO_WORKER_INSTALL_ROOT: "" };
    expect(() => execFileSync("bash", [join(ROOT, "scripts", "demo-worker-install.sh")], { env, stdio: "pipe" })).toThrow();
  });
});
