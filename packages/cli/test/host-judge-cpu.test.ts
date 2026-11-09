import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HOST_CALL_MS, HOST_ENGINE, hostArgs, hostBackstopMs, hostDetail, judgeHost, hostTally, wireArgs } from "../src/host-judge.js";
import { engineOutcome, failedCases, ranPastBudget } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";

const POSIX = { skip: process.platform === "win32", timeout: 180_000 } as const;
const ONE = [{ args: [2], expected: 4 }];
const cases = (caseMs?: number, list: Cases["cases"] = ONE): Cases => ({ steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: list, ...(caseMs === undefined ? {} : { caseMs }) });
const bytes = (source: string) => new TextEncoder().encode(source);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const LOOP = "export default () => { for (;;) {} };";

const CORRECT = "export default (n) => { let x = 0; for (let i = 0; i < 2e8; i += 1) x = (x + i) % 7; return n * 2 + (x === -1 ? 1 : 0); };";

async function throttled(source: string, list: Cases, runMs: number, stopMs: number) {
  const budgetMs = list.caseMs ?? HOST_CALL_MS;
  const input = JSON.stringify({ source, cases: list.cases.map((c) => ({ ...wireArgs(c.args), expected: c.expected })), budgetMs, backstopMs: hostBackstopMs(budgetMs), detail: hostDetail(list.cases.length) });
  const child = spawn(process.execPath, hostArgs(1), { env: {}, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  let running = true;
  const closed = new Promise<number | null>((done) => child.once("close", (code) => {
    running = false;
    done(code);
  }));
  child.stdin.end(input);
  const started = performance.now();
  void (async () => {
    while (running) {
      await pause(runMs);
      if (running) child.kill("SIGSTOP");
      await pause(stopMs);
      if (running) child.kill("SIGCONT");
    }
  })();
  const code = await closed;
  const tally = hostTally(JSON.parse(output), list.cases.length, budgetMs);
  return { code, wallMs: performance.now() - started, tally, outcome: engineOutcome(HOST_ENGINE, tally).outcome };
}

describe("the host engine's budget is CPU time, not the judge's wall clock", () => {
  it("passes a correct module that needs more wall time than its budget when the judge's CPU is throttled to a tenth", POSIX, async () => {
        expect(await judgeHost(bytes(CORRECT), cases(), 20)).toEqual({ engine: HOST_ENGINE, total: 1, passed: 1, failures: [] });
    const slowed = await throttled(CORRECT, cases(), 20, 180);
    expect(slowed.code).toBe(0);
    expect(slowed.wallMs).toBeGreaterThan(HOST_CALL_MS);
    expect(slowed.outcome).toBe("pass");
  });

  it("makes a call the backstop stops before it used its budget infra, never fail", POSIX, async () => {
    const starved = await throttled(LOOP, cases(), 20, 380);
    expect(starved.outcome).toBe("infra");
    expect(starved.tally.failures).toEqual([]);
    expect(starved.tally.stop).toMatchObject({ cause: "fault", unfinished: 1 });
  });

  it("still fails an endless loop under a lighter throttle, since it uses its budget before the backstop", POSIX, async () => {
    const halved = await throttled(LOOP, cases(), 200, 50);
    expect([halved.outcome, halved.tally.failures]).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: ranPastBudget(HOST_CALL_MS) }]]);
  });

  it("fails an endless loop and slow wrong work under a pinned case_ms, and runs no case after the first that used its budget", async () => {
    const budget = 200;
    for (const source of [LOOP, "export default (n) => { let x = 0; for (let i = 0; i < 4e9; i += 1) x = (x + i) % 7; return n * 3 + x; };", "for (;;) {} export default () => 4;"]) {
      const judged = await judgeHost(bytes(source), cases(budget, [...ONE, ...ONE, ...ONE]), 60);
      expect(engineOutcome(HOST_ENGINE, judged).outcome, source).toBe("fail");
      expect(judged.failures[0], source).toEqual({ case: 0, verdict: "stopped", detail: ranPastBudget(budget) });
    }
    const looped = await judgeHost(bytes(LOOP), cases(budget, [...ONE, ...ONE, ...ONE]), 60);
    expect(looped).toMatchObject({ total: 3, passed: 0, stop: { cause: "failed", unfinished: 2 } });
  }, 120_000);

  it("leaves a delivery no way to wait without CPU: Atomics.wait is gone from the host engine", async () => {
    const waiting = await judgeHost(bytes("export default () => typeof Atomics.wait;"), cases(undefined, [{ args: [], expected: "undefined" }]), 20);
    expect(waiting.passed).toBe(1);
    const blocking = await judgeHost(bytes("export default () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return 4; };"), cases(), 20);
    expect([engineOutcome(HOST_ENGINE, blocking).outcome, blocking.failures[0]?.verdict]).toEqual(["fail", "threw"]);
  });

  it("leaves a call that answered rightly past its budget, but under twice it, no verdict only while other work kept the CPUs busy", () => {
    const busy = { usedMs: HOST_CALL_MS * 1.5, otherShare: 0.5 };
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "pass", ...busy }], 1, HOST_CALL_MS)).outcome).toBe("infra");
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "wrong", detail: 5, ...busy }], 1, HOST_CALL_MS))).toEqual({ outcome: "fail", reason: failedCases(HOST_ENGINE, 1, 1) });
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS * 1.5, otherShare: 0 }], 1, HOST_CALL_MS)).outcome).toBe("fail");
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS * 2, otherShare: 1 }], 1, HOST_CALL_MS)).outcome).toBe("fail");
  });

  it("runs microtasks a delivery queues inside the call that queued them, so a loop there is a stopped case, never a deadline", async () => {
    for (const source of ["Promise.resolve().then(() => { for (;;) {} }); export default (x) => x * 2;", "export default (x) => { Promise.resolve().then(() => { for (;;) {} }); return x * 2; };"]) {
      const judged = await judgeHost(bytes(source), cases(200), 60);
      expect([engineOutcome(HOST_ENGINE, judged).outcome, judged.failures[0]?.verdict], source).toEqual(["fail", "stopped"]);
    }
  }, 120_000);

  it("charges CPU used past the budget as a fail even when the call answered", () => {
    expect(hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS, otherShare: 0 }], 1, HOST_CALL_MS)).toMatchObject({ passed: 0, failures: [{ case: 0, verdict: "stopped" }] });
    expect(hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS - 1, otherShare: 0 }], 1, HOST_CALL_MS)).toMatchObject({ passed: 1, failures: [] });
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "stopped", usedMs: HOST_CALL_MS - 1, otherShare: 0 }], 1, HOST_CALL_MS)).outcome).toBe("infra");
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "stopped", usedMs: HOST_CALL_MS, otherShare: 0 }], 1, HOST_CALL_MS)).outcome).toBe("fail");
  });
});
