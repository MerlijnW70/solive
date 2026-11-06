import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeNode, NODE_ENGINE, OUT_OF_TURN, PROTOCOL_BROKEN, TOO_LONG } from "../src/node-judge.js";
import { NODE_READY } from "../src/node-runner.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { engineOutcome, failedCases } from "../src/verdict-model.js";
import { type Cases, OUTPUT_BYTES } from "../src/viper.js";

const fake = vi.hoisted(() => ({ reply: "" }));

const REPLIES: Record<string, string> = {
  forged: "process.stdout.write('not a frame\\n');",
  token: "process.stdout.write(JSON.stringify({ token: 'f'.repeat(64), out: '', code: 0, signal: null, timedOut: false, over: false }) + '\\n');",
  stale: "process.stdout.write(JSON.stringify({ token, out: '', code: 0, signal: null, timedOut: false, over: false }).replace(token, token.slice(1) + '0') + '\\n');",
  long: `process.stdout.write('x'.repeat(${2 * OUTPUT_BYTES + 1}));`,
};

const launcher = (reply: string) =>
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
    "    const { token } = JSON.parse(line);",
    `    ${reply}`,
    "  }",
    "});",
  ].join("\n");

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [command, args, options] = all as unknown as [string, string[], object | undefined];
    if (command !== "docker" || !Array.isArray(args) || args[0] !== "run") return actual.spawn(...all);
    return actual.spawn(process.execPath, ["-e", launcher(fake.reply)], options ?? {});
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

vi.mock("../src/check-process.js", async (original) => {
  const actual = await original<typeof import("../src/check-process.js")>();
  return {
    ...actual,
    endedState: vi.fn(async () => ({ state: { started: true, exitCode: 0, oomKilled: false, error: "" } })),
    removeContainer: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  fake.reply = "";
});

const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
const MODULE = new TextEncoder().encode('export default (text) => text.split(" ").length;\n');

describe("the plain Node engine's channel", () => {
  it("fails the case and stops the run on a line out of turn, an answer under another token, or a line longer than it reads", async () => {
    for (const [name, detail] of [
      ["forged", OUT_OF_TURN],
      ["token", OUT_OF_TURN],
      ["stale", OUT_OF_TURN],
      ["long", TOO_LONG],
    ] as const) {
      fake.reply = REPLIES[name] ?? "";
      const { judged } = await judgeNode(BOX, MODULE, "count.mjs", CASES, 7, 60);
      expect([judged.passed, judged.failures, judged.stop], name).toEqual([0, [{ case: 0, verdict: "crashed", detail }], { cause: "fault", reason: PROTOCOL_BROKEN, unfinished: 1 }]);
      expect(engineOutcome(NODE_ENGINE, judged), name).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 1, 2) });
    }
  });
});
