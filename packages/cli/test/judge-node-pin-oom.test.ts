import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeRefused, oomInfra } from "../src/judge-errors.js";
import { CASE_UNMETERED, judgeNode, memoryUnlocked, NODE_ENGINE } from "../src/node-judge.js";
import { NODE_READY, NODE_UNLOCKED, UNPREPARED } from "../src/node-runner.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { caseFilledChosen, caseFilledPinned, caseOomInfra, caseOomPinned, caseUnsettled, engineOutcome, failedCases, hostKillPinned, killedUnflagged, launcherFlaggedPinned, launcherKilledPinned, type MemoryRise, OOM_UNREAD_PINNED } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";

type Reply = { code: number | null; signal: string | null; before: MemoryRise | null; after: MemoryRise | null; value?: number; settled?: boolean; verdict?: string; metered?: boolean };

const fake = vi.hoisted(() => ({ oomKilled: true, exitCode: 137, readyFirst: true, filledFirst: false, runs: [] as string[][], replies: undefined as Reply[] | undefined, greeting: "" }));

const at = (oom: number, oomKill: number = oom): MemoryRise => ({ oom, oomKill });

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
    `    if (seen === 1) { process.stdout.write(${JSON.stringify(fake.greeting === "" ? NODE_READY : fake.greeting)} + '\\n'); continue; }`,
    "    const { token } = JSON.parse(line);",
    "    const reply = replies[seen - 2];",
    "    const framed = reply.verdict === undefined ? ['answer', 'number', String(reply.value)] : [reply.verdict, 'string', 'no capability'];",
    "    const out = reply.value === undefined && reply.verdict === undefined ? '' : Buffer.from('\\n' + token + JSON.stringify(framed) + token + '\\n').toString('base64');",
    "    process.stdout.write(JSON.stringify({ token, out, code: reply.code, signal: reply.signal, timedOut: false, over: false, oomBefore: reply.before, oomAfter: reply.after, settled: reply.settled !== false, clock: { started: true, metered: reply.metered !== false, usedMs: 1, idleMs: 0, ioMs: 0, displaced: 0, stoppedBy: null } }) + '\\n');",
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
    `    if (seen === 2 && ${String(filledFirst)}) { const { token } = JSON.parse(line); process.stdout.write(JSON.stringify({ token, out: '', code: 1, signal: null, timedOut: false, over: false, oomBefore: { oom: 0, oomKill: 0 }, oomAfter: { oom: 1, oomKill: 1 }, clock: { started: true, metered: true, usedMs: 1, idleMs: 0, ioMs: 0, displaced: 0, stoppedBy: null } }) + '\\n'); continue; }`,
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
  fake.greeting = "";
});

const MEMORY = "384m";
const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
const PINNED: Cases = { ...CASES, nodeMemory: MEMORY };
const MODULE = new TextEncoder().encode('export default (text) => text.split(" ").length;\n');
const option = (args: string[], name: string) => args.flatMap((arg, at) => (arg === name ? [args[at + 1]] : []));

describe("a plain Node container that ends while a case runs", () => {
  it("is infra under the pinned memory when Docker flags it out of memory, since the flag names no process and counts host kills, and runs under exactly the pin", async () => {
    for (const [oomKilled, exitCode] of [
      [true, 137],
      [true, 1],
    ] as const) {
      fake.oomKilled = oomKilled;
      fake.exitCode = exitCode;
      fake.runs = [];
      const pinned = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
      expect([pinned.judged.passed, pinned.judged.failures, pinned.judged.stop], `${oomKilled} ${exitCode}`).toEqual([0, [], { cause: "fault", reason: launcherFlaggedPinned(MEMORY), unfinished: 2 }]);
      expect(engineOutcome(NODE_ENGINE, pinned.judged)).toEqual({ outcome: "infra", reason: launcherFlaggedPinned(MEMORY) });
      expect(caseOomPinned(MEMORY)).not.toBe(launcherFlaggedPinned(MEMORY));
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
    expect([early.judged.failures, engineOutcome(NODE_ENGINE, early.judged)]).toEqual([[], { outcome: "infra", reason: launcherFlaggedPinned(MEMORY) }]);
    const chosenEarly = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([chosenEarly.judged.failures, engineOutcome(NODE_ENGINE, chosenEarly.judged)]).toEqual([[], { outcome: "infra", reason: oomInfra(MEMORY) }]);
  });

  it("charges a flag set by an earlier case's memory kill to that case only, not to the case running when the container ends", async () => {
    fake.filledFirst = true;
    const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([
      0,
      [{ case: 0, verdict: "crashed", detail: caseFilledPinned(MEMORY) }],
      { cause: "fault", reason: launcherFlaggedPinned(MEMORY), unfinished: 1 },
    ]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 1, 2) });
  });
});

describe("the out-of-memory count a plain Node case is judged by", () => {
  it("is read from that case's own start, so a memory kill in one case is not charged to the clean case after it", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: 0, signal: null, before: at(0), after: at(1), value: 2 },
      { code: null, signal: "SIGKILL", before: at(1), after: at(1) },
    ];
    const chosen = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([chosen.judged.passed, chosen.judged.stop, chosen.judged.failures.map((failure) => failure.verdict)]).toEqual([1, undefined, ["crashed"]]);
    expect(engineOutcome(NODE_ENGINE, chosen.judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 1, 2) });
    fake.replies = [
      { code: 0, signal: null, before: at(0), after: at(1), value: 2 },
      { code: 0, signal: null, before: at(2), after: at(2), value: 1 },
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
    const rising = { code: 0, signal: null, before: at(0), after: at(1), value: 1 };
    fake.replies = [{ code: 0, signal: null, before: at(0), after: at(0), value: 2, settled: false }, rising];
    const blurred = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([blurred.judged.passed, blurred.judged.failures, blurred.judged.stop]).toEqual([1, [], { cause: "fault", reason: caseUnsettled(MEMORY), unfinished: 1 }]);
    expect(engineOutcome(NODE_ENGINE, blurred.judged)).toEqual({ outcome: "infra", reason: caseUnsettled(MEMORY) });
    fake.replies = [{ code: 0, signal: null, before: at(0), after: at(0), value: 2 }, rising];
    const settled = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([settled.judged.passed, settled.judged.failures]).toEqual([1, [{ case: 1, verdict: "crashed", detail: caseFilledPinned(MEMORY) }]]);
  });
});

describe("the two out-of-memory counts a plain Node case is judged by", () => {
  it("makes a case infra under the pin when oom_kill rose and oom did not, since the host's killer may have killed it", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    for (const reply of [{ code: null, signal: "SIGKILL" }, { code: 1, signal: null }, { code: 0, signal: null, value: 2 }]) {
      fake.replies = [{ ...reply, before: at(3, 3), after: at(3, 4) }];
      const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
      expect([judged.passed, judged.failures, judged.stop], JSON.stringify(reply)).toEqual([0, [], { cause: "fault", reason: hostKillPinned(MEMORY), unfinished: 2 }]);
      expect(engineOutcome(NODE_ENGINE, judged), JSON.stringify(reply)).toEqual({ outcome: "infra", reason: hostKillPinned(MEMORY) });
    }
  });

  it("fails a case under the pin when both oom and oom_kill rose while it ran", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: null, signal: "SIGKILL", before: at(3, 3), after: at(4, 4) },
      { code: 0, signal: null, before: at(4, 4), after: at(5, 6), value: 1 },
    ];
    const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([judged.passed, judged.stop, judged.failures]).toEqual([
      0,
      undefined,
      [
        { case: 0, verdict: "crashed", detail: caseOomPinned(MEMORY) },
        { case: 1, verdict: "crashed", detail: caseFilledPinned(MEMORY) },
      ],
    ]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 2, 2) });
  });

  it("lets the memory counts, not a lost CPU reading, decide a case the kernel killed for memory", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: null, signal: "SIGKILL", before: at(0), after: at(1), metered: false },
      { code: 0, signal: null, before: at(1), after: at(1), value: 1 },
    ];
    const pinned = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([pinned.judged.passed, pinned.judged.stop, pinned.judged.failures]).toEqual([1, undefined, [{ case: 0, verdict: "crashed", detail: caseOomPinned(MEMORY) }]]);
    fake.replies = [{ code: null, signal: "SIGKILL", before: at(0, 0), after: at(3, 0), metered: false }];
    const reached = await judgeNode(BOX, MODULE, "count.mjs", { ...PINNED, cases: [PINNED.cases[0] ?? { args: [], expected: 0 }] }, 7, 60);
    expect([reached.judged.stop, reached.judged.failures, engineOutcome(NODE_ENGINE, reached.judged).outcome]).toEqual([undefined, [{ case: 0, verdict: "crashed", detail: caseFilledPinned(MEMORY) }], "fail"]);
    fake.replies = [{ code: 0, signal: null, before: at(0, 0), after: at(3, 0), value: 2 }];
    const touched = await judgeNode(BOX, MODULE, "count.mjs", { ...PINNED, cases: [PINNED.cases[0] ?? { args: [], expected: 0 }] }, 7, 60);
    expect([touched.judged.passed, touched.judged.failures, touched.judged.stop]).toEqual([1, [], undefined]);
    fake.replies = [{ code: null, signal: "SIGKILL", before: null, after: at(3, 0), metered: false }];
    const unread = await judgeNode(BOX, MODULE, "count.mjs", { ...PINNED, cases: [PINNED.cases[0] ?? { args: [], expected: 0 }] }, 7, 60);
    expect([unread.judged.failures, engineOutcome(NODE_ENGINE, unread.judged).outcome]).toEqual([[], "infra"]);
    fake.replies = [{ code: null, signal: "SIGKILL", before: at(0), after: at(1), metered: false }];
    const chosen = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([chosen.judged.failures, chosen.judged.stop?.reason]).toEqual([[], caseOomInfra(MEMORY)]);
    fake.replies = [{ code: 0, signal: null, before: at(0), after: at(0), value: 2, metered: false }];
    const unmetered = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([unmetered.judged.failures, unmetered.judged.stop?.reason]).toEqual([[], CASE_UNMETERED]);
  });

  it("reads the kernel's group kill from the launcher, and then charges the fill to the case without saying its own process used it", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: null, signal: "SIGKILL", before: { oom: 3, oomKill: 3, groupKill: 0 }, after: { oom: 4, oomKill: 6, groupKill: 1 } },
      { code: null, signal: "SIGKILL", before: { oom: 4, oomKill: 6, groupKill: 1 }, after: { oom: 5, oomKill: 7, groupKill: 1 } },
    ];
    const { judged } = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([judged.passed, judged.stop, judged.failures]).toEqual([
      0,
      undefined,
      [
        { case: 0, verdict: "crashed", detail: caseFilledPinned(MEMORY) },
        { case: 1, verdict: "crashed", detail: caseOomPinned(MEMORY) },
      ],
    ]);
    fake.replies = [{ code: null, signal: "SIGKILL", before: { oom: 0, oomKill: 0, groupKill: 2 }, after: { oom: 1, oomKill: 1, groupKill: 1 } }];
    const fallen = await judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60);
    expect([fallen.judged.failures, engineOutcome(NODE_ENGINE, fallen.judged).outcome]).toEqual([[], "infra"]);
  });

  it("makes a case that exits non-zero after a memory kill infra under the memory the judge chose, and passes one that answers rightly", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [{ code: 1, signal: null, before: at(0), after: at(0, 1) }];
    const failed = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([failed.judged.passed, failed.judged.failures, failed.judged.stop]).toEqual([0, [], { cause: "fault", reason: caseFilledChosen(MEMORY), unfinished: 2 }]);
    expect(engineOutcome(NODE_ENGINE, failed.judged)).toEqual({ outcome: "infra", reason: caseFilledChosen(MEMORY) });
    fake.replies = [
      { code: 0, signal: null, before: at(0), after: at(1), value: 2 },
      { code: 0, signal: null, before: at(1), after: at(2), value: 1 },
    ];
    const passed = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([passed.judged.passed, passed.judged.failures, passed.judged.stop]).toEqual([2, [], undefined]);
  });

  it("makes a case that could not drop to its user and score an engine fault, which is infra, never a fail", async () => {
    fake.exitCode = 0;
    fake.oomKilled = false;
    fake.replies = [
      { code: 0, signal: null, before: at(0), after: at(0), verdict: UNPREPARED },
      { code: 0, signal: null, before: at(0), after: at(0), value: 1 },
    ];
    const { judged } = await judgeNode({ ...BOX, memory: MEMORY }, MODULE, "count.mjs", CASES, 7, 60);
    expect([judged.passed, judged.failures, judged.faults]).toEqual([1, [], 1]);
    expect(engineOutcome(NODE_ENGINE, judged).outcome).toBe("infra");
  });

  it("refuses a pin when the launcher's probe case could lower its out-of-memory score", async () => {
    fake.greeting = NODE_UNLOCKED;
    fake.replies = [];
    await expect(judgeNode(BOX, MODULE, "count.mjs", PINNED, 7, 60)).rejects.toThrow(new JudgeRefused(memoryUnlocked(MEMORY)));
  });
});
