import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JudgeRefused } from "../src/judge-errors.js";
import {
  CLOCK_FROM,
  CLOCK_TO,
  SEED_LIMIT,
  casesOf,
  type Cases,
  DEFAULT_HEAP,
  DEFAULT_STEPS,
  decodeOutput,
  judgeViper,
  MAX_CASES,
  permissionFlag,
  pinnedWasm,
  REPORTED_FAILURES,
  VIPER_WASM_SHA256,
  wasmPath,
} from "../src/viper.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const WORD_COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }";

const spec = (json: string, extra = "") => new TextEncoder().encode(`# A job\n\n${extra}\`\`\`judge-cases\n${json}\n\`\`\`\n`);

const cases = (list: Cases["cases"], over: Partial<Cases> = {}): Cases => ({ steps: 2_000_000, heap: 16 << 20, seed: 7, clock: 0, cases: list, ...over });

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JudgeRefused);
    return (error as Error).message;
  }
  throw new Error("it was not refused");
};

const judged = async (source: string, list: Cases["cases"], over: Partial<Cases> = {}, timeout = 30) =>
  judgeViper(await pinnedWasm(), new TextEncoder().encode(source), cases(list, over), timeout);

describe("the cases a spec pins", () => {
  it("reads one judge-cases block and fills in the budgets", () => {
    expect(casesOf(spec('{"cases": [{"args": ["a b"], "expected": 2}, {"args": [], "expected": null}]}'))).toEqual({
      steps: DEFAULT_STEPS,
      heap: DEFAULT_HEAP,
      seed: undefined,
      clock: undefined,
      cases: [
        { args: ["a b"], expected: 2 },
        { args: [], expected: null },
      ],
    });
    expect(casesOf(spec('{"steps": 5, "heap": 1024, "seed": 9, "clock": 1700000000000, "cases": [{"args": [true], "expected": "x"}]}'))).toMatchObject({
      steps: 5,
      heap: 1024,
      seed: 9,
      clock: 1700000000000,
    });
  });

  it("refuses a spec with no block, two blocks or a block it cannot trust", () => {
    expect(refusal(() => casesOf(new TextEncoder().encode("# no cases")))).toContain("holds 0");
    expect(refusal(() => casesOf(spec('{"cases": [{"args": [], "expected": 1}]}', '```judge-cases\n{"cases": []}\n```\n')))).toContain("holds 2");
    for (const [json, said] of [
      ["{", "is not JSON"],
      ["[]", "is not a JSON object"],
      ['{"cases": []}', "from 1 to"],
      ['{"cases": [{"args": [], "expected": 1}], "run": "x"}', 'field "run"'],
      ['{"cases": [{"args": [{}], "expected": 1}]}', "case 0, whose args"],
      ['{"cases": [{"args": [], "expected": [1]}]}', "case 0, whose expected"],
      ['{"cases": [{"args": []}]}', "case 0, which is not"],
      ['{"cases": [{"args": [], "expected": 1, "extra": 2}]}', "case 0, which is not"],
      ['{"steps": -1, "cases": [{"args": [], "expected": 1}]}', "steps -1"],
      ['{"heap": 1e12, "cases": [{"args": [], "expected": 1}]}', "heap 1000000000000"],
      [`{"cases": [${Array(MAX_CASES + 1).fill('{"args": [], "expected": 1}').join(",")}]}`, "from 1 to"],
    ] as const) {
      expect(refusal(() => casesOf(spec(json))), json.slice(0, 40)).toContain(said);
    }
  });
});

describe("the pinned module", () => {
  it("is the module the build script pins, and a changed byte is refused", async () => {
    expect(readFileSync(join(ASSETS, "viperjs-judge.sha256"), "utf8").trim()).toBe(VIPER_WASM_SHA256);
    const bytes = await pinnedWasm();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(VIPER_WASM_SHA256);
    const changed = Buffer.from(bytes);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
    const path = join(mkdtempSync(join(tmpdir(), "viper-")), "judge.wasm");
    writeFileSync(path, changed);
    await expect(pinnedWasm(path)).rejects.toThrow("not the pinned");
    await expect(pinnedWasm(join(tmpdir(), "no-such-judge.wasm"))).rejects.toThrow("is missing");
    expect(wasmPath()).toBe(join(ASSETS, "viperjs-judge.wasm"));
  });

  it("runs in a process that may read no file", () => {
    const tried = spawnSync(process.execPath, [permissionFlag(), "--input-type=module", "-e", "import { readFileSync } from 'node:fs'; readFileSync(process.execPath);"], {
      env: {},
      encoding: "utf8",
    });
    expect(tried.status).not.toBe(0);
    expect(tried.stderr).toContain("ERR_ACCESS_DENIED");
  });
});

describe("a delivery judged by the module", () => {
  const counts = [
    { args: [""], expected: 0 },
    { args: ["one"], expected: 1 },
    { args: ["one\ttwo　three"], expected: 3 },
  ];

  it("passes when every case passes and names the cases that do not", async () => {
    expect(await judged(WORD_COUNT, counts)).toEqual({ total: 3, passed: 3, failures: [], seed: 7, clock: 0 });
    expect(await judged("export default (t) => t.split(' ').length;", counts)).toMatchObject({
      total: 3,
      passed: 1,
      failures: [
        { case: 0, verdict: "wrong", detail: 1 },
        { case: 2, verdict: "wrong", detail: 1 },
      ],
    });
  });

  it("gives every attack the verdict that is not a pass", async () => {
    const one = [{ args: ["a b"], expected: 0 }];
    const attacks: [string, string][] = [
      ["JSON.stringify = () => '0'; Object.is = () => true; export default () => 42;", "wrong"],
      ["export default () => ({ valueOf() { return 0; } });", "not-primitive"],
      ["while (true) {} export default () => 0;", "stopped"],
      ["export default () => { for (;;) {} };", "stopped"],
      ["export default function f() { return f() + 1; }", "threw"],
      ["import fs from 'node:fs'; export default () => 0;", "no-module"],
      ["export default () => typeof process + typeof require + typeof fetch;", "wrong"],
    ];
    for (const [source, verdict] of attacks) {
      const result = await judged(source, one);
      expect(result.passed, source).toBe(0);
      expect(result.failures[0]?.verdict, source).toBe(verdict);
    }
    const bomb = await judged("export default () => { const a = []; for (;;) a.push(new Array(1e5).fill(1)); };", one);
    expect(["threw", "stopped"]).toContain(bomb.failures[0]?.verdict);
  });

  it("answers the same twice and reports a bounded number of failures", async () => {
    const reads = "export default () => Math.random() + '|' + Date.now();";
    const twice = [await judged(reads, [{ args: [], expected: null }], { clock: 1_700_000_000_000 }), await judged(reads, [{ args: [], expected: null }], { clock: 1_700_000_000_000 })];
    expect(twice[0]).toEqual(twice[1]);
    expect(String(twice[0]?.failures[0]?.detail)).toMatch(/\|1700000000000$/);
    const many = await judged("export default () => 1;", Array(REPORTED_FAILURES + 5).fill({ args: [], expected: 0 }));
    expect(many.passed).toBe(0);
    expect(many.failures).toHaveLength(REPORTED_FAILURES);
  });

  it("stops the whole process at the wall clock", async () => {
    const slow = await judged("export default () => { for (;;) {} };", [{ args: [], expected: 0 }], { steps: 1e9 }, 0.5);
    expect(slow.failures[0]).toMatchObject({ verdict: "stopped" });
    expect(String(slow.failures[0]?.detail)).toContain("did not finish");
  });

  it("draws a fresh seed and clock for a spec that pins neither, and records them", async () => {
    const reads = "export default () => Math.random() + '|' + Date.now();";
    const unpinned = { seed: undefined, clock: undefined };
    const runs = [await judged(reads, [{ args: [], expected: null }], unpinned), await judged(reads, [{ args: [], expected: null }], unpinned)];
    for (const run of runs) {
      expect(run.seed).toBeGreaterThanOrEqual(1);
      expect(run.seed).toBeLessThan(SEED_LIMIT);
      expect(run.clock).toBeGreaterThanOrEqual(CLOCK_FROM);
      expect(run.clock).toBeLessThan(CLOCK_TO);
      expect(String(run.failures[0]?.detail)).toMatch(new RegExp(`\|${run.clock}$`));
    }
    expect(runs[0]?.seed).not.toBe(runs[1]?.seed);
    expect(runs[0]?.failures[0]?.detail).not.toBe(runs[1]?.failures[0]?.detail);
    const again = await judged(reads, [{ args: [], expected: null }], { seed: runs[0]?.seed, clock: runs[0]?.clock });
    expect(again).toEqual(runs[0]);
  });

  it("names a judge process that ends without a verdict crashed", async () => {
    const importing = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02, 0x07, 0x01, 0x01, 0x61, 0x01, 0x62, 0x00, 0x00]);
    const crashed = await judgeViper(importing, new TextEncoder().encode(WORD_COUNT), cases([{ args: [], expected: 0 }]), 30);
    expect(crashed).toMatchObject({ passed: 0, failures: [{ case: 0, verdict: "crashed" }] });
    expect(String(crashed.failures[0]?.detail)).toContain("exit code 3");
  });

  it("refuses a delivery that is not UTF-8 text", async () => {
    await expect(judgeViper(await pinnedWasm(), Uint8Array.from([0xff, 0xfe]), cases([{ args: [], expected: 0 }]), 30)).rejects.toThrow("not UTF-8");
  });

  it("refuses an answer that is not exactly the verdicts it asked for", () => {
    const head = Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(decodeOutput(Buffer.concat([head, Buffer.from([0])]), 1)).toEqual([{ verdict: "pass" }]);
    expect(refusal(() => decodeOutput(Buffer.concat([head, Buffer.from([0, 0])]), 1))).toContain("more than");
    expect(refusal(() => decodeOutput(head, 1))).toContain("truncated");
    expect(refusal(() => decodeOutput(Buffer.concat([head, Buffer.from([9])]), 1))).toContain("does not have");
    expect(refusal(() => decodeOutput(Buffer.concat([head, Buffer.from([0])]), 2))).toContain("1 verdicts for 2");
    expect(refusal(() => decodeOutput(Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 0]), 0))).toContain("refused its own input");
  });
});
