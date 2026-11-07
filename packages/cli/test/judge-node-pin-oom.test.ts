import { afterEach, describe, expect, it, vi } from "vitest";
import { oomInfra } from "../src/judge-errors.js";
import { judgeNode, NODE_ENGINE } from "../src/node-judge.js";
import { NODE_READY } from "../src/node-runner.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { caseFilledPinned, caseOomPinned, caseUnsettled, engineOutcome, failedCases, killedUnflagged, launcherKilledPinned, OOM_UNREAD_PINNED } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";

type Reply = { code: number | null; signal: string | null; before: number | null; after: number | null; value?: number; settled?: boolean };

const fake = vi.hoisted(() => ({ oomKilled: true, exitCode: 137, readyFirst: true, filledFirst: false, runs: [] as string[][], replies: undefined as Reply[] | undefined }));

const replying = (replies: Reply[]) =>
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
    "    const out = reply.value === undefined ? '' : Buffer.from('\\n' + token + JSON.stringify(['answer', 'number', String(reply.value)]) + token + '\\n').toString('base64');",
    "    process.stdout.write(JSON.stringify({ token, out, code: reply.code, signal: reply.signal, timedOut: false, over: false, oomBefore: reply.before, oomAfter: reply.after, settled: reply.settled !== false }) + '\\n');",
    "  }",
    "});",
  ].join("\n");

const launcher = (filledFirst: boolean) =>
  [
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
    `    if (seen === 2 && ${String(filledFirst)}) { const { token } = JSON.parse(line); process.stdout.write(JSON.stringify({ token, out: '', code: 1, signal: null, timedOut: false, over: false, oomBefore: 0, oomAfter: 1 }) + '\\n'); continue; }`,
    "    process.exit(137);",
    "  }",
    "});",
  ].join("\n");

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [command, args, options] = all as unknown as [string, string[], object | undefined];
    if (command !== "docker" || !Array.isArray(args) || args[0] !== "run") return actual.spawn(...all);
    fake.runs.push(args);
    const script = fake.replies !== undefined ? replying(fake.replies) : fake.readyFirst ? launcher(fake.filledFirst) : "process.exit(137);";
    return actual.spawn(process.execPath, ["-e", script], options ?? {});
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

vi.mock("../src/check-process.js", async (original) => {
  const actual = await original<typeof import("../src/check-process.js")>();
  return {
    ...actual,
    endedState: vi.fn(async () => ({ state: { started: true, exitCode: fake.exitCode, oomKilled: fake.oomKilled, error: "" } })),
    removeContainer: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  fake.oomKilled = true;
  fake.exitCode = 137;
  fake.readyFirst = true;
  fake.filledFirst = false;
  fake.runs = [];
  fake.replies = undefined;
});

const MEMORY = "384m";
const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
const PINNED: Cases = { ...CASES, nodeMemory: MEMORY };
const MODULE = new TextEncoder().encode('export default (text) => text.split(" ").length;\n');
const option = (args: string[], name: string) => args.flatMap((arg, at) => (arg === name ? [args[at + 1]] : []));

describe("a plain Node container that ends while a case runs", () => {
  it("fails that case under the pinned memory when Docker flags it out of memory, and runs under exactly the pin", async () => {
    for (const [oomKilled, exitCode] of [
      [true, 137],
      [true, 1],
    ] as const) {
      fake.oomKilled = oomKilled;
      fake.exitCode = exitCode;
      fake.runs = [];
      const pinned = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
      expect([pinned.judged.passed, pinned.judged.failures, pinned.judged.stop], `${oomKilled} ${exitCode}`).toEqual([
        0,
        [{ case: 0, verdict: "crashed", detail: caseOomPinned(MEMORY) }],
        { cause: "fault", reason: caseOomPinned(MEMORY), unfinished: 1 },
      ]);
      expect(engineOutcome(NODE_ENGINE, pinned.judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 1, 2) });
      expect([option(fake.runs[0] ?? [], "--memory"), option(fake.runs[0] ?? [], "--memory-swap")]).toEqual([[MEMORY], [MEMORY]]);
    }
  });

  it("is infra under the pin when the launcher ends with signal 9 and Docker did not flag it out of memory, since no case can signal the launcher", async () => {
    fake.oomKilled = false;
    const pinned = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([pinned.judged.passed, pinned.judged.failures, pinned.judged.stop]).toEqual([0, [], { cause: "fault", reason: launcherKilledPinned(MEMORY), unfinished: 2 }]);
    expect(engineOutcome(NODE_ENGINE, pinned.judged)).toEqual({ outcome: "infra", reason: launcherKilledPinned(MEMORY) });
  });

  it("is infra under the memory the judge chose, and under the pin when nothing points at memory or no case was running", async () => {
    const chosen = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect(engineOutcome(NODE_ENGINE, chosen.judged)).toEqual({ outcome: "infra", reason: oomInfra(MEMORY) });
    fake.oomKilled = false;
    const unflagged = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect(engineOutcome(NODE_ENGINE, unflagged.judged)).toEqual({ outcome: "infra", reason: killedUnflagged(MEMORY) });
    fake.exitCode = 1;
    const other = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([other.judged.failures, engineOutcome(NODE_ENGINE, other.judged).outcome]).toEqual([[], "infra"]);
    fake.oomKilled = true;
    fake.exitCode = 137;
    fake.readyFirst = false;
    const early = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([early.judged.failures, engineOutcome(NODE_ENGINE, early.judged)]).toEqual([[], { outcome: "infra", reason: oomInfra(MEMORY) }]);
  });

  it("charges a flag set by an earlier case's memory kill to that case only, not to the case running when the container ends", async () => {
    fake.filledFirst = true;
    const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([
      0,
      [{ case: 0, verdict: "crashed", detail: caseFilledPinned(MEMORY) }],
      { cause: "fault", reason: oomInfra(MEMORY), unfinished: 1 },
    ]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 1, 2) });
  });
});

describe("the out-of-memory count a plain Node case is judged by", () => {
  it("is read from that case's own start, so a memory kill in one case is not charged to the clean case after it", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: 1, signal: null, before: 0, after: 1 },
      { code: null, signal: "SIGKILL", before: 1, after: 1 },
    ];
    const chosen = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([chosen.judged.passed, chosen.judged.stop, chosen.judged.failures.map((failure) => failure.verdict)]).toEqual([0, undefined, ["crashed", "crashed"]]);
    expect(engineOutcome(NODE_ENGINE, chosen.judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 2, 2) });
    fake.replies = [
      { code: 0, signal: null, before: 0, after: 1, value: 2 },
      { code: 0, signal: null, before: 2, after: 2, value: 1 },
    ];
    const pinned = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([pinned.judged.passed, pinned.judged.stop, pinned.judged.failures]).toEqual([1, undefined, [{ case: 0, verdict: "crashed", detail: caseFilledPinned(MEMORY) }]]);
  });

  it("is infra under the pin when it cannot be read around a case, even one that answered rightly", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [{ code: 0, signal: null, before: null, after: null, value: 2 }];
    const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([0, [], { cause: "fault", reason: OOM_UNREAD_PINNED, unfinished: 2 }]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "infra", reason: OOM_UNREAD_PINNED });
  });

  it("is not charged as a fail to a case that started before every process of the case before it had ended", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    const rising = { code: 0, signal: null, before: 0, after: 1, value: 1 };
    fake.replies = [{ code: 0, signal: null, before: 0, after: 0, value: 2, settled: false }, rising];
    const blurred = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([blurred.judged.passed, blurred.judged.failures, blurred.judged.stop]).toEqual([1, [], { cause: "fault", reason: caseUnsettled(MEMORY), unfinished: 1 }]);
    expect(engineOutcome(NODE_ENGINE, blurred.judged)).toEqual({ outcome: "infra", reason: caseUnsettled(MEMORY) });
    fake.replies = [{ code: 0, signal: null, before: 0, after: 0, value: 2 }, rising];
    const settled = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([settled.judged.passed, settled.judged.failures]).toEqual([1, [{ case: 1, verdict: "crashed", detail: caseFilledPinned(MEMORY) }]]);
  });
});
