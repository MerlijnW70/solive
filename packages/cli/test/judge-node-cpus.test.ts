import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { judgeNode, NODE_ENGINE, nodeBackstopMs } from "../src/node-judge.js";
import { KEEPER_OOM_SCORE } from "../src/node-runner.js";
import { SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { engineOutcome, ranPastBudget, spentBudget } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";
import { DOCKER } from "./docker-switch.js";

const SLOW = { skip: !DOCKER, timeout: 900_000 } as const;
const box = (cpus: string) => ({ image: SANDBOX_IMAGE, memory: "1g", cpus, tmp: SANDBOX_TMP, gpu: false });
const bytes = (source: string) => new TextEncoder().encode(source);
const ONE = [{ args: [2], expected: 4 }];
const cases = (caseMs?: number): Cases => ({ steps: 10_000_000, heap: 1 << 26, seed: 1, clock: 0, cases: ONE, ...(caseMs === undefined ? {} : { caseMs }) });
const WORK = (loops: number) => `export default (n) => { let x = 0; for (let i = 0; i < ${loops}; i += 1) x = (x + i * 7) % 1000003; return n * 2 + (x === -1 ? 1 : 0); };`;
const SPIN_TO = (ms: number) => `export default (n) => { const from = process.cpuUsage(); while (process.cpuUsage(from).user + process.cpuUsage(from).system < ${ms} * 1000) {} return n * 2; };`;
const judged = async (source: string, cpus: string, list: Cases) => {
  const { judged: node } = await judgeNode(box(cpus), bytes(source), "work.mjs", list, 1, 600);
  return { node, outcome: engineOutcome(NODE_ENGINE, node).outcome };
};

describe("plain Node cases under the judge's --sandbox-cpus choice", () => {
  it("gives one correct module the same verdict at 1 CPU and at 0.1 CPU, where the old wall-clock limit failed it", SLOW, async () => {
    const correct = WORK(2.5e8);
    const full = await judged(correct, "1", cases());
    expect(full.outcome).toBe("pass");
    const tenth = await judged(correct, "0.1", cases());
    expect(tenth.outcome).toBe("pass");
    expect(tenth.node.failures).toEqual([]);
  });

  it("fails an endless loop, a busy wait, a blocked event loop and slow wrong work under a pinned budget, at both shares", SLOW, async () => {
    const budget = 500;
    const loops = [
      "export default () => { for (;;) {} };",
      "export default () => { const until = Date.now() + 1e9; while (Date.now() < until) {} return 4; };",
      "export default () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return 4; };",
      "export default () => { const cell = new Int32Array(new SharedArrayBuffer(4)); for (;;) Atomics.wait(cell, 0, 0, 50); };",
      "await new Promise((done) => setTimeout(done, 1e9)); export default () => 4;",
      "import { execFileSync } from 'node:child_process'; export default () => { execFileSync(process.execPath, ['-e', 'for (;;) {}']); return 4; };",
      "import { Worker } from 'node:worker_threads'; export default () => { for (let i = 0; i < 4; i += 1) new Worker('for (;;) {}', { eval: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return 4; };",
      "export default (n) => { let x = 0; for (let i = 0; i < 4e9; i += 1) x = (x + i * 7) % 1000003; return n * 3 + (x === -1 ? 1 : 0); };",
    ];
    for (const cpus of ["1", "0.1"]) {
      for (const source of loops) {
        const started = performance.now();
        const { node, outcome } = await judged(source, cpus, cases(budget));
        expect([outcome, node.failures], `${cpus} ${source}`).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: spentBudget(budget) }]]);
        expect(performance.now() - started, `${cpus} ${source}`).toBeLessThan(nodeBackstopMs(budget, cpus) + 30_000);
      }
    }
  });

  it("leaves only a case's own processes for the kernel to kill for memory: the launcher and the container's init are out of its choice", SLOW, async () => {
    const probe = "import { readFileSync } from 'node:fs'; export default () => ['' + process.ppid, '1'].map((pid) => readFileSync('/proc/' + pid + '/oom_score_adj', 'utf8').trim()).join(' ');";
    const { judged: node } = await judgeNode(box("1"), bytes(probe), "keepers.mjs", { ...cases(), cases: [{ args: [], expected: `${KEEPER_OOM_SCORE} ${KEEPER_OOM_SCORE}` }] }, 1, 600);
    expect([node.passed, node.failures]).toEqual([1, []]);
  });

  it("fails a correct case charged past its budget on a quiet host, the same verdict an idle judge gives", SLOW, async () => {
    const { node, outcome } = await judged(SPIN_TO(1_400), "1", cases(1_000));
    expect([outcome, node.failures]).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: ranPastBudget(1_000) }]]);
  });

  it("charges CPU spent in children the kernel reaps itself, so such work neither passes over budget nor turns its fail into infra", SLOW, async () => {
    const budget = 500;
    const one = "my $p = fork(); if ($p == 0) { my $x = 0; $x++ while $x < 2500000; exit 0 } select(undef, undef, undef, 0.01) while kill 0, $p;";
    const hiding = [
      `import { spawn } from 'node:child_process'; spawn('perl', ['-e', "$SIG{CHLD} = 'IGNORE'; while (1) { ${one} }"], { stdio: 'ignore' }); await new Promise(() => setInterval(() => {}, 1000)); export default () => 4;`,
      `import { execFileSync } from 'node:child_process'; export default (n) => { execFileSync('perl', ['-e', "$SIG{CHLD} = 'IGNORE'; for (1..60) { ${one} }"]); return n * 2; };`,
    ];
    for (const cpus of ["1", "0.1"]) {
      for (const source of hiding) {
        const { node, outcome } = await judged(source, cpus, cases(budget));
        expect([outcome, node.failures], `${cpus} ${source}`).toEqual(["fail", [{ case: 0, verdict: "stopped", detail: spentBudget(budget) }]]);
      }
    }
  });
});
