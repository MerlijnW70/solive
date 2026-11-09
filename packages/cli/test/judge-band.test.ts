import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_CALL_MS, HOST_ENGINE, hostTally, unthrottled } from "../src/host-judge.js";
import { caseVerdict, clockOf, judgeNode, launcherSilent, LEFT_MEMORY_STOP, leftMemory, NODE_ENGINE, nodeBackstopMs, nodeWatchMs } from "../src/node-judge.js";
import { NODE_READY } from "../src/node-runner.js";
import { SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { caseTiming, contendedCase, CONTENTION_FACTOR, displacedShare, DISPLACED_LIMIT, engineOutcome, ranPastBudget, spentBudget, stoppedDetail } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";

type Reply = { usedMs: number; displaced: number; value?: number; kept?: number; silent?: boolean };

const fake = vi.hoisted(() => ({ replies: [] as Reply[], asked: 0 }));

const launcher = (replies: Reply[]) =>
  [
    `const replies = ${JSON.stringify(replies)};`,
    "let seen = 0;",
    "let rest = '';",
    "process.stdin.on('data', (chunk) => {",
    "  rest += String(chunk);",
    "  let at = rest.indexOf('\\n');",
    "  while (at >= 0) {",
    "    const line = rest.slice(0, at);",
    "    rest = rest.slice(at + 1);",
    "    at = rest.indexOf('\\n');",
    "    seen += 1;",
    `    if (seen === 1) { process.stdout.write(${JSON.stringify(NODE_READY)} + '\\n'); continue; }`,
    "    const { token } = JSON.parse(line);",
    "    const reply = replies[seen - 2];",
    "    process.stderr.write('asked\\n');",
    "    if (reply.silent) { setInterval(() => {}, 1000); continue; }",
    "    const out = Buffer.from('\\n' + token + JSON.stringify(['answer', 'number', String(reply.value)]) + token + '\\n').toString('base64');",
    "    const clock = { started: true, metered: true, usedMs: reply.usedMs, idleMs: 0, ioMs: 0, displaced: reply.displaced, stoppedBy: null };",
    "    process.stdout.write(JSON.stringify({ token, out, code: 0, signal: null, timedOut: false, over: false, oomBefore: { oom: 0, oomKill: 0 }, oomAfter: { oom: 0, oomKill: 0 }, settled: true, kept: reply.kept ?? 0, clock }) + '\\n');",
    "  }",
    "});",
  ].join("\n");

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [command, args, options] = all as unknown as [string, string[], object | undefined];
    if (command !== "docker" || !Array.isArray(args) || args[0] !== "run") return actual.spawn(...all);
    const child = actual.spawn(process.execPath, ["-e", launcher(fake.replies)], { ...(options ?? {}), stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => {
      fake.asked += String(chunk).split("asked").length - 1;
    });
    return child;
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

vi.mock("../src/check-process.js", async (original) => {
  const actual = await original<typeof import("../src/check-process.js")>();
  return { ...actual, endedState: vi.fn(async () => ({ state: { started: true, exitCode: 137, oomKilled: false, error: "" } })), removeContainer: vi.fn(async () => undefined) };
});

afterEach(() => {
  fake.replies = [];
  fake.asked = 0;
});

const BUDGET = 100;
const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, caseMs: BUDGET, cases: [{ args: [2], expected: 4 }, { args: [3], expected: 6 }] };
const judged = async (replies: Reply[], seconds = 60) => {
  fake.replies = replies;
  const { judged: node } = await judgeNode(BOX, new Uint8Array(), "work.mjs", CASES, 1, seconds);
  return { node, outcome: engineOutcome(NODE_ENGINE, node) };
};
const at = (usedMs: number, displaced: number) => caseTiming({ started: true, usedMs, idleMs: 0, ioMs: 0, displaced, stoppedBy: null }, 1_000);

describe("the infra band opens only on the case's own measured displacement", () => {
  it("fails a right answer past its budget on a quiet host, and leaves it no verdict only when other work kept it off its CPU", () => {
    expect([at(999, 1), at(1_000, 0), at(1_000, DISPLACED_LIMIT - 0.001), at(1_999, 0.2)]).toEqual(["within", "over", "over", "over"]);
    expect([at(1_000, DISPLACED_LIMIT), at(1_999, 1)]).toEqual(["band", "band"]);
    expect([at(2_000, 1), at(2_000, 0), at(5_000, 1)]).toEqual(["spent", "spent", "spent"]);
  });

  it("measures displacement as the CPU a continuously ready case was due and did not get", () => {
    expect(displacedShare([], 1, 0, 100)).toBe(0);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 1_000 }], 1, 0, 100)).toBe(0);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 600 }], 1, 0, 100)).toBeCloseTo(0.4);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 3_000 }, { spanMs: 1_000, usedMs: 500 }], 1, 0, 100)).toBeCloseTo(0.25);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 100 }], 0.1, 0, 100)).toBe(0);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 50 }], 0.1, 0, 100)).toBeCloseTo(0.5);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 900 }], 1, 100, 100)).toBe(0);
    expect(displacedShare([{ spanMs: 1_000, usedMs: 800 }], 1, 100, 100)).toBeCloseTo(0.1);
    expect(displacedShare([{ spanMs: 99, usedMs: 0 }, { spanMs: 1_000, usedMs: 1_000 }], 1, 0, 100)).toBe(0);
    expect(displacedShare([{ spanMs: 100, usedMs: 0 }], 1, 0, 100)).toBe(1);
  });

  it("names the limit that stopped a case: its budget, or twice it", () => {
    expect(stoppedDetail("over", 500)).toBe(ranPastBudget(500));
    expect(stoppedDetail("spent", 500)).toBe(spentBudget(500));
    expect(spentBudget(500)).toContain(`${500 * CONTENTION_FACTOR} ms, twice its 500 ms budget`);
    expect(ranPastBudget(500)).not.toContain("twice");
    expect(caseVerdict({ token: "t", out: "", code: 0, timedOut: true, over: false }, "t", 4, "spent", 500)).toEqual({ verdict: "stopped", detail: spentBudget(500) });
    expect(caseVerdict({ token: "t", out: "", code: 0, timedOut: false, over: false }, "t", 4, "over", 500)).toEqual({ verdict: "stopped", detail: ranPastBudget(500) });
    expect(hostTally([{ verdict: "stopped", usedMs: HOST_CALL_MS * CONTENTION_FACTOR, displaced: 1 }], 1, HOST_CALL_MS).failures).toEqual([{ case: 0, verdict: "stopped", detail: spentBudget(HOST_CALL_MS) }]);
    expect(hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS * 1.5, displaced: 0 }], 1, HOST_CALL_MS).failures).toEqual([{ case: 0, verdict: "stopped", detail: ranPastBudget(HOST_CALL_MS) }]);
  });

  it("reads only a displacement share between 0 and 1 from the launcher", () => {
    const clock = { started: true, metered: true, usedMs: 1, idleMs: 0, ioMs: 0, stoppedBy: null };
    expect(clockOf({ ...clock, displaced: 1 })?.displaced).toBe(1);
    for (const displaced of [-0.1, 1.01, Number.NaN, "1", undefined]) expect(clockOf({ ...clock, displaced }), String(displaced)).toBeNull();
  });

  it("opens the host engine's band only when its cgroup was readable and not throttled", () => {
    expect(unthrottled({ count: 3, periodMs: 100 }, { count: 3, periodMs: 100 })).toBe(true);
    expect([unthrottled({ count: 3, periodMs: 100 }, { count: 4, periodMs: 100 }), unthrottled(null, { count: 0, periodMs: 0 }), unthrottled({ count: 0, periodMs: 0 }, null)]).toEqual([false, false, false]);
  });
});

describe("plain Node under the band, through the launcher's channel", () => {
  it("fails a wrong answer in the band and leaves a right one there no verdict", async () => {
    const wrong = await judged([{ usedMs: BUDGET * 1.5, displaced: 1, value: 5 }, { usedMs: 1, displaced: 0, value: 6 }]);
    expect([wrong.outcome.outcome, wrong.node.failures, wrong.node.stop]).toEqual(["fail", [{ case: 0, verdict: "wrong", detail: 5 }], undefined]);
    const right = await judged([{ usedMs: BUDGET * 1.5, displaced: 1, value: 4 }]);
    expect([right.outcome, right.node.failures]).toEqual([{ outcome: "infra", reason: contendedCase("the plain Node engine", BUDGET, 1) }, []]);
  });

  it("fails a right answer past its budget when the launcher measured too little displacement, and names twice the budget at the kill", async () => {
    const quiet = await judged([{ usedMs: BUDGET * 1.5, displaced: DISPLACED_LIMIT - 0.01, value: 4 }, { usedMs: 1, displaced: 0, value: 6 }]);
    expect([quiet.outcome.outcome, quiet.node.failures]).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: ranPastBudget(BUDGET) }]]);
    const spent = await judged([{ usedMs: BUDGET * CONTENTION_FACTOR, displaced: 1, value: 4 }, { usedMs: 1, displaced: 0, value: 6 }]);
    expect([spent.outcome.outcome, spent.node.failures]).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: spentBudget(BUDGET) }]]);
  });

  it("charges memory a case left behind to that case and runs no case after it", async () => {
    const kept = await judged([{ usedMs: 1, displaced: 0, value: 4, kept: 300 * 2 ** 20 }, { usedMs: 1, displaced: 0, value: 6 }]);
    expect([kept.outcome.outcome, kept.node.failures, kept.node.stop]).toEqual(["fail", [{ case: 0, verdict: "crashed", detail: leftMemory(300 * 2 ** 20) }], { cause: "failed", reason: LEFT_MEMORY_STOP, unfinished: 1 }]);
    expect(fake.asked).toBe(1);
    const clean = await judged([{ usedMs: 1, displaced: 0, value: 4, kept: 0 }, { usedMs: 1, displaced: 0, value: 6 }]);
    expect([clean.node.passed, clean.node.failures]).toEqual([2, []]);
  });

  it("ends a launcher that stops answering between cases promptly as infra, long before the judgement's deadline", async () => {
    const watchMs = nodeWatchMs(nodeBackstopMs(BUDGET, "1"));
    const started = performance.now();
    const silent = await judged([{ usedMs: 1, displaced: 0, value: 4 }, { usedMs: 0, displaced: 0, silent: true }], 600);
    expect([silent.node.passed, silent.node.failures, silent.outcome]).toEqual([1, [], { outcome: "infra", reason: launcherSilent(watchMs) }]);
    expect(performance.now() - started).toBeLessThan(watchMs + 10_000);
  }, 60_000);
});

describe("the host engine's band", () => {
  it("fails a wrong answer in the band and opens it for a right one only past the limit", () => {
    const band = { usedMs: HOST_CALL_MS * 1.5, displaced: DISPLACED_LIMIT };
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "wrong", detail: 5, ...band }], 1, HOST_CALL_MS)).outcome).toBe("fail");
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "pass", ...band }], 1, HOST_CALL_MS)).outcome).toBe("infra");
    expect(engineOutcome(HOST_ENGINE, hostTally([{ verdict: "pass", usedMs: HOST_CALL_MS * 1.5, displaced: DISPLACED_LIMIT - 0.01 }], 1, HOST_CALL_MS)).outcome).toBe("fail");
  });
});
