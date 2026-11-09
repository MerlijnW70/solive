import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_CALL_MS } from "../src/host-judge.js";
import { FAIL_RECEIPT_DIR } from "../src/judge-receipt.js";
import { runProblem, runRead } from "../src/judge-run.js";
import { clockOf, NODE_BOOT_MS, NODE_CASE_MS, nodeBackstopMs } from "../src/node-judge.js";
import { nodeCpusDiffers, nodeMemoryDiffers, runPlan } from "../src/run-plan.js";
import { SANDBOX_IMAGE, SANDBOX_TMP, type Sandbox } from "../src/sandbox.js";
import { caseTiming, chargedMs } from "../src/verdict-model.js";
import { CASE_MS_MAX, CASE_MS_MIN, CASE_MS_RULE, casesOf, NODE_CPUS_RULE } from "../src/viper.js";

const CASES = '"cases": [{"args": ["a b"], "expected": 2}]';
const specWith = (fields: string) => new TextEncoder().encode(`# Job\n\n\`\`\`judge-cases\n{${fields}${CASES}}\n\`\`\`\n`);
const box = (memory: string, cpus: string) => ({ image: SANDBOX_IMAGE, memory, cpus, tmp: SANDBOX_TMP, gpu: false });
const command = (sandbox: Sandbox, given: string[]) => ({ sandbox, run: undefined, timeout: 600, given }) as unknown as Parameters<typeof runPlan>[1];
const refused = (why: string) => `the spec's judge-cases block ${why}; nothing was run or paid`;

describe("the case_ms and node_cpus pins of a judge-cases block", () => {
  it("are read by casesOf and the spec readers", () => {
    const spec = specWith('"case_ms": 750, "node_cpus": "0.5", ');
    expect(casesOf(spec)).toMatchObject({ caseMs: 750, nodeCpus: "0.5" });
    expect([runProblem(spec), runRead(spec)]).toEqual([undefined, { node_cpus: "0.5", case_ms: 750 }]);
    expect(casesOf(specWith(""))).not.toHaveProperty("caseMs");
  });

  it("refuse a value no judge can honour, in judge and the hirer's checks", () => {
    for (const [field, value, rule] of [
      ["case_ms", "99", CASE_MS_RULE],
      ["case_ms", "60001", CASE_MS_RULE],
      ["case_ms", '"500"', CASE_MS_RULE],
      ["node_cpus", '"0"', NODE_CPUS_RULE],
      ["node_cpus", "2", NODE_CPUS_RULE],
    ] as const) {
      const spec = specWith(`"${field}": ${value}, `);
      const why = `has ${field} ${value}, which is not ${rule}`;
      expect(() => casesOf(spec), `${field} ${value}`).toThrow(refused(why));
      expect(runProblem(spec), `${field} ${value}`).toBe(`the spec's judge-cases block ${why}`);
    }
  });

  it("make runPlan run plain Node with the pinned CPUs and refuse a --sandbox-cpus that differs", () => {
    const spec = specWith('"node_cpus": "0.5", "node_memory": "1g", ');
    expect(runPlan(spec, command({ kind: "viper", node: box("512m", "1") }, [])).sandbox).toEqual({ kind: "viper", node: box("1g", "0.5") });
    expect(runPlan(spec, command({ kind: "viper", node: box("1g", "0.50") }, ["sandbox-cpus", "sandbox-memory"])).sandbox).toEqual({ kind: "viper", node: box("1g", "0.5") });
    expect(() => runPlan(spec, command({ kind: "viper", node: box("1g", "0.1") }, ["sandbox-cpus"]))).toThrow(`--sandbox-cpus ${nodeCpusDiffers("0.1", "0.5")}; nothing was run or paid`);
    expect(() => runPlan(spec, command({ kind: "viper", node: box("2g", "0.5") }, ["sandbox-memory"]))).toThrow(nodeMemoryDiffers("2g", "1g"));
    expect(runPlan(spec, command({ kind: "viper" }, ["sandbox-cpus"]))).toEqual({ sandbox: { kind: "viper" }, run: undefined, timeout: 600 });
    expect(runPlan(specWith('"case_ms": 500, '), command({ kind: "viper", node: box("1g", "0.1") }, ["sandbox-cpus"])).sandbox).toEqual({ kind: "viper", node: box("1g", "0.1") });
  });
});

describe("the timing rule every engine's budget follows", () => {
  it("fails a case that used its budget of CPU and waiting time, whoever stopped it", () => {
    for (const stoppedBy of [null, "budget", "backstop"] as const) {
      expect(caseTiming({ started: true, usedMs: 400, idleMs: 100, ioMs: 0, stoppedBy }, 500), String(stoppedBy)).toBe("over");
      expect(caseTiming({ started: true, usedMs: 0, idleMs: 500, ioMs: 0, stoppedBy }, 500), String(stoppedBy)).toBe("over");
    }
  });

  it("makes a judge's stop before the budget was used infra, and leaves a case that ended within it to its answer", () => {
    expect(caseTiming({ started: true, usedMs: 499, idleMs: 0, ioMs: 0, stoppedBy: "backstop" }, 500)).toBe("starved");
    expect(caseTiming({ started: false, usedMs: 0, idleMs: 0, ioMs: 0, stoppedBy: "backstop" }, 500)).toBe("starved");
    expect(caseTiming({ started: false, usedMs: 900, idleMs: 900, ioMs: 0, stoppedBy: "backstop" }, 500)).toBe("starved");
    expect(caseTiming({ started: true, usedMs: 499, idleMs: 0, ioMs: 0, stoppedBy: null }, 500)).toBe("within");
    expect(caseTiming({ started: false, usedMs: 0, idleMs: 0, ioMs: 0, stoppedBy: null }, 500)).toBe("within");
  });

  it("charges time a case's processes wait on the disk only past one budget of it, so the judge's disk load is free and parking there is not", () => {
    expect(caseTiming({ started: true, usedMs: 0, idleMs: 0, ioMs: 500, stoppedBy: "backstop" }, 500)).toBe("starved");
    expect(caseTiming({ started: true, usedMs: 0, idleMs: 0, ioMs: 999, stoppedBy: null }, 500)).toBe("within");
    expect(caseTiming({ started: true, usedMs: 0, idleMs: 0, ioMs: 1000, stoppedBy: null }, 500)).toBe("over");
    expect(caseTiming({ started: true, usedMs: 200, idleMs: 100, ioMs: 700, stoppedBy: null }, 500)).toBe("over");
    expect(chargedMs({ started: true, usedMs: 200, idleMs: 100, ioMs: 400, stoppedBy: null }, 500)).toBe(300);
  });

  it("gives plain Node a backstop past what a case's own processes can stall it, at any CPU share", () => {
    for (const cpus of ["0.01", "0.1", "0.5", "1", "4"]) {
      const share = Number(cpus);
      for (const budget of [100, 5_000, 60_000]) {
        const selfStall = budget * (1 + 1 / share);
        const diskAllowance = budget;
        expect(nodeBackstopMs(budget, cpus) - NODE_BOOT_MS / share - selfStall - diskAllowance, `${cpus} ${budget}`).toBeGreaterThanOrEqual(budget);
      }
    }
  });

  it("reads the launcher's clock only in its own form", () => {
    expect(clockOf({ started: true, metered: true, usedMs: 1, idleMs: 2, ioMs: 0, stoppedBy: "budget" })).toEqual({ started: true, metered: true, usedMs: 1, idleMs: 2, ioMs: 0, stoppedBy: "budget" });
    for (const bad of [null, {}, { started: true, metered: true, usedMs: -1, idleMs: 0, ioMs: 0, stoppedBy: null }, { started: true, metered: true, usedMs: 1, idleMs: Number.NaN, ioMs: 0, stoppedBy: null }, { started: true, metered: true, usedMs: 1, idleMs: 0, ioMs: 0, stoppedBy: "work" }]) {
      expect(clockOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const doc = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the judge docs on budgets and receipts", () => {
  it("state the constants the code uses", () => {
    const guide = doc("docs/judge.md");
    expect(guide).not.toContain("a fail or infra saves none");
    expect(guide).toContain(`Every fail saves a fail receipt in \`~/.config/intent-engine/${FAIL_RECEIPT_DIR}\`, and \`reject\` refuses without one. Infra and refusals save none.`);
    expect(guide).toContain(`\`HOST_CALL_MS\` (${HOST_CALL_MS} ms)`);
    expect(guide).toContain(`\`NODE_CASE_MS\` (${NODE_CASE_MS} ms)`);
    expect(guide).toContain("a whole number of milliseconds from " + CASE_MS_MIN + " to " + CASE_MS_MAX);
    expect(CASE_MS_RULE).toBe("a whole number of milliseconds from " + CASE_MS_MIN + " to " + CASE_MS_MAX);
    const internals = doc("docs/maintainers/judge-internals.md");
    expect(internals).toContain("before it used its budget, or plain Node cannot read a case's CPU time | infra | 75 | no |");
    expect(internals).not.toContain("the host engine's per-call limit, the plain Node per-case limit");
  });
});
