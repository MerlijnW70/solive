import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { judgeNode, NODE_ENGINE } from "../src/node-judge.js";
import { SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { engineOutcome, ranPastBudget } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";
import { DOCKER } from "./docker-switch.js";

const SLOW = { skip: !DOCKER, timeout: 900_000 } as const;
const BUDGET = 1_000;
const box = (cpus: string) => ({ image: SANDBOX_IMAGE, memory: "1g", cpus, tmp: SANDBOX_TMP, gpu: false });
const bytes = (source: string) => new TextEncoder().encode(source);
const cases = (count = 1): Cases => ({ steps: 10_000_000, heap: 1 << 26, seed: 1, clock: 0, caseMs: BUDGET, cases: Array.from({ length: count }, () => ({ args: [2], expected: 4 })) });
const judged = async (source: string, cpus = "1", list = cases()) => {
  const { judged: node } = await judgeNode(box(cpus), bytes(source), "work.mjs", list, 1, 600);
  return { node, outcome: engineOutcome(NODE_ENGINE, node) };
};
const spinTo = (ms: number) => `const from = process.cpuUsage(); while (process.cpuUsage(from).user + process.cpuUsage(from).system < ${ms} * 1000) {}`;
const SPIN = `export default (n) => { ${spinTo(1_400)}; return n * 2; };`;
const OVER = [{ case: 0, verdict: "stopped", detail: ranPastBudget(BUDGET) }];
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const SEND = "use Socket; my $send = sub { my ($via, @fds) = @_; my $data = 'd'; my $iov = pack('P L!', $data, 1); my $cmsg = pack('L! i i', 16 + 4 * @fds, SOL_SOCKET, 1) . pack('i*', @fds); $cmsg .= \"\\0\" x ((8 - length($cmsg) % 8) % 8); syscall(46, fileno($via), pack('x8 L x4 P L! P L! i x4', 0, $iov, 1, $cmsg, length($cmsg), 0), 0) >= 0 or die \"sendmsg $!\"; }; socketpair(my $a, my $b, AF_UNIX, SOCK_STREAM, PF_UNSPEC) or die;";
const PARK_MEMFD = `${SEND} my $name = 'x'; my $fd = syscall(319, $name, 0); open(my $m, '+<&=', $fd) or die; my $c = 'z' x 1048576; syswrite($m, $c) for 1 .. 280; $send->($b, fileno($a), $fd); $send->($a, fileno($b));`;
const PARK_PIPES = `${SEND} my $c = 'z' x 65536; for (1 .. 200) { pipe(my $r, my $w) or die; fcntl($w, 1031, 1048576); fcntl($w, 4, 2048); for (1 .. 16) { last unless syswrite($w, $c) } $send->($b, fileno($r), fileno($w)); close $r; close $w; } $send->($b, fileno($a)); $send->($a, fileno($b));`;
const parking = (perl: string) => `import { spawnSync } from "node:child_process"; export default (n) => { const ran = spawnSync("perl", ["-e", ${JSON.stringify(perl)}], { encoding: "utf8" }); if (ran.status !== 0) return "perl " + ran.status + " " + ran.stderr; return n * 2; };`;

const ATTACKS: Record<string, string> = {
  "many threads against the quota": `import { Worker } from "node:worker_threads"; export default (n) => { for (let i = 0; i < 32; i += 1) new Worker("const t = Date.now(); while (Date.now() - t < 150) {}", { eval: true }); ${spinTo(1_400)}; return n * 2; };`,
  "self-throttling bursts with short sleeps": `import { Worker } from "node:worker_threads"; export default (n) => { const ws = []; for (let i = 0; i < 16; i += 1) ws.push(new Worker("const c = new Int32Array(new SharedArrayBuffer(4)); for (;;) { const t = performance.now(); while (performance.now() - t < 3) {} Atomics.wait(c, 0, 0, 40); }", { eval: true })); const cell = new Int32Array(new SharedArrayBuffer(4)); const from = process.cpuUsage(); while (process.cpuUsage(from).user + process.cpuUsage(from).system < 1400000) { const t = performance.now(); while (performance.now() - t < 120) {} Atomics.wait(cell, 0, 0, 2); } for (const w of ws) w.terminate(); return n * 2; };`,
  "sleeping between short runs": `export default (n) => { const cell = new Int32Array(new SharedArrayBuffer(4)); const from = process.cpuUsage(); while (process.cpuUsage(from).user + process.cpuUsage(from).system < 700000) { const t = performance.now(); while (performance.now() - t < 1) {} Atomics.wait(cell, 0, 0, 1); } return n * 2; };`,
  "a fork storm": `import { spawnSync } from "node:child_process"; export default (n) => { spawnSync("perl", ["-e", "for (1..400) { my $p = fork(); if ($p == 0) { exit 0 } waitpid($p, 0); }"]); ${spinTo(1_200)}; return n * 2; };`,
  "softirq load from a loopback flood": `import { spawn } from "node:child_process"; export default (n) => { const c = spawn("perl", ["-e", "use Socket; socket(my $s, PF_INET, SOCK_DGRAM, 0); socket(my $r, PF_INET, SOCK_DGRAM, 0); bind($r, sockaddr_in(9999, INADDR_LOOPBACK)); my $to = sockaddr_in(9999, INADDR_LOOPBACK); my $m = 'x' x 1400; my $t = time; while (time - $t < 3) { send($s, $m, 0, $to) for 1..200; my $b; recv($r, $b, 2000, 0) for 1..50; }"], { stdio: "ignore" }); ${spinTo(900)}; c.kill("SIGKILL"); return n * 2; };`,
  "memory pressure": `export default (n) => { const kept = []; const from = process.cpuUsage(); while (process.cpuUsage(from).user + process.cpuUsage(from).system < 1400000) { kept.push(Buffer.alloc(1 << 20, 1)); if (kept.length > 700) kept.length = 0; } return n * 2; };`,
};

describe("the plain Node band on a real container", () => {
  it("fails a right answer charged past its budget while host processes keep every CPU busy, since they barely take the case's CPU", SLOW, async () => {
    const hogs: ChildProcess[] = [];
    for (const nice of ["0", "19"]) for (let i = 0; i < availableParallelism(); i += 1) hogs.push(spawn("nice", ["-n", nice, process.execPath, "-e", "for (;;) {}"], { stdio: "ignore" }));
    try {
      await pause(1_000);
      const { node, outcome } = await judged(SPIN);
      expect([outcome.outcome, node.failures]).toEqual(["fail", OVER]);
    } finally {
      for (const hog of hogs) hog.kill("SIGKILL");
    }
  });

  it("leaves a right answer charged past its budget no verdict when other work truly kept the case off its CPU", SLOW, async () => {
    const name = `band-hog-${process.pid}`;
    spawn("docker", ["run", "--rm", "--name", name, "--cpu-shares", "262144", "--entrypoint", "sh", SANDBOX_IMAGE, "-c", `for i in $(seq ${2 * availableParallelism()}); do while :; do :; done & done; wait`], { stdio: "ignore" });
    try {
      await pause(3_000);
      const { node, outcome } = await judged(SPIN);
      expect([outcome.outcome, node.failures]).toEqual(["infra", []]);
      expect(node.stop?.reason).toMatch(/kept it off the CPU for \d+% of the time it was ready to run/);
    } finally {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    }
  });

  it("gives work no way to raise its own displacement: each attack with a right answer past its budget fails on a quiet host", SLOW, async () => {
    for (const cpus of ["1", "0.1"]) {
      for (const [attack, source] of Object.entries(ATTACKS)) {
        if (cpus === "0.1" && !attack.includes("thr")) continue;
        const { node, outcome } = await judged(source, cpus);
        expect([outcome.outcome, node.failures], `${cpus} ${attack}`).toEqual(["fail", OVER]);
      }
    }
  });

  it("waits until memory a case parked in a socket in flight is freed, so the next case gets the whole pinned memory", SLOW, async () => {
    const pinned: Cases = { ...cases(2), nodeMemory: "384m", cases: [{ args: ["park"], expected: 4 }, { args: ["fill"], expected: 4 }] };
    for (const perl of [PARK_MEMFD, PARK_PIPES]) {
      const source = `import { spawnSync } from "node:child_process"; export default (mode) => { if (mode === "fill") { const kept = []; for (let i = 0; i < 200; i += 1) kept.push(Buffer.alloc(1 << 20, 1)); return kept.length > 0 ? 4 : 0; } const ran = spawnSync("perl", ["-e", ${JSON.stringify(perl)}], { encoding: "utf8" }); return ran.status === 0 ? 4 : "perl " + ran.status + " " + ran.stderr; };`;
      const { judged: node } = await judgeNode(box("1"), bytes(source), "work.mjs", pinned, 1, 600);
      expect([node.passed, node.failures, node.stop]).toEqual([2, [], undefined]);
    }
  });

  it("passes a case that parks nothing, with the same launcher, so the check reads the case and not the host", SLOW, async () => {
    const { node } = await judged(`export default (n) => n * 2;`, "1", cases(2));
    expect([node.passed, node.failures]).toEqual([2, []]);
  });

  it("leaves a case no file it could write to keep memory past its end", SLOW, async () => {
    const probe = `import { writeFileSync } from "node:fs"; export default () => ["/tmp", "/dev/shm", "/dev", "/var/tmp", "/run", "/judge", "/", "/dev/mqueue", "."].filter((dir) => { try { writeFileSync(dir + "/x", "x"); return true; } catch { return false; } }).join(",");`;
    const { judged: node } = await judgeNode(box("1"), bytes(probe), "work.mjs", { ...cases(), cases: [{ args: [], expected: "" }] }, 1, 600);
    expect([node.passed, node.failures]).toEqual([1, []]);
  });
});
