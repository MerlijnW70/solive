import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { EXIT_RETRY, INFRA_NEXT } from "../src/judge-errors.js";
import { EXIT_FAILED } from "../src/main.js";
import { judgeNode, NODE_ENGINE } from "../src/node-judge.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP } from "../src/sandbox.js";
import { engineOutcome, failedCases } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";
import { announced, keyed } from "./announce.js";
import { DOCKER_TEST, selfKilledChosen, selfKilledPinned } from "./docker-switch.js";
import { cli, funded, NOW, transport, world } from "./harness.js";
import { status } from "./judge-kit.js";

const MEMORY = "384m";
const BOX = { image: SANDBOX_IMAGE, memory: "1g", cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
const bytes = (source: string) => new TextEncoder().encode(source);
const lines = (...all: string[]) => `${all.join("\n")}\n`;
const COUNT = 'export default (text) => text.split(" ").length;';
const inNode = (body: string) => lines("if (import.meta.url !== undefined) {", body, "}", COUNT);
const FILLER = inNode("const kept = []; for (;;) kept.push(Buffer.alloc(1 << 20, 1));");

const PROBE = lines(
  "import { openSync, readFileSync } from 'node:fs';",
  "const field = (pid, name) => readFileSync('/proc/' + pid + '/status', 'utf8').split('\\n').find((line) => line.startsWith(name + ':')).split(/\\s+/).slice(1).join(' ');",
  "const code = (act) => { try { act(); return 'allowed'; } catch (error) { return error.code; } };",
  "const report = JSON.stringify({",
  "  launcher: field(process.ppid, 'Uid'),",
  "  init: field(1, 'Uid'),",
  "  uid: field('self', 'Uid'),",
  "  gid: field('self', 'Gid'),",
  "  groups: field('self', 'Groups'),",
  "  caps: ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].map((name) => field('self', name)),",
  "  noNewPrivs: field('self', 'NoNewPrivs'),",
  "  signals: [process.ppid, 1].flatMap((pid) => ['SIGSTOP', 'SIGKILL', 'SIGUSR1', 'SIGTERM', 'SIGCONT', 0].map((signal) => code(() => process.kill(pid, signal)))),",
  "  opens: [process.ppid, 1].flatMap((pid) => [['mem', 'r'], ['mem', 'r+'], ['fd/0', 'r'], ['fd/1', 'w'], ['environ', 'r'], ['oom_score_adj', 'w']].map(([path, mode]) => code(() => openSync('/proc/' + pid + '/' + path, mode)))),",
  "  setuid: code(() => process.setuid(0)),",
  "});",
  "export default () => report;",
);

const SEPARATED = JSON.stringify({
  launcher: "0 0 0 0",
  init: "0 0 0 0",
  uid: "65534 65534 65534 65534",
  gid: "65534 65534 65534 65534",
  groups: "",
  caps: ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"],
  noNewPrivs: "1",
  signals: Array(12).fill("EPERM"),
  opens: Array(12).fill("EACCES"),
  setuid: "EPERM",
});

describe("a plain Node case and its launcher", () => {
  it("run under different uids, so the case can neither signal, trace, read nor write the launcher, nor gain its uid or capabilities", DOCKER_TEST, async () => {
    const cases: Cases = { ...CASES, cases: [{ args: [], expected: SEPARATED }, { args: [], expected: SEPARATED }] };
    const { judged } = await judgeNode(BOX, bytes(PROBE), "probe.mjs", cases, 7, 60);
    expect(judged.failures).toEqual([]);
    expect([judged.passed, judged.stop]).toEqual([2, undefined]);
  });
});

const PERL_IPC = [
  'my $r = "";',
  'my $id = shmget(0, 1048576, 896); $r .= "shm " . (defined $id ? "created" : "$!");',
  '$id = msgget(0, 896); $r .= " msg " . (defined $id ? "created" : "$!");',
  '$id = semget(0, 1, 896); $r .= " sem " . (defined $id ? "created" : "$!");',
  'my $name = "q"; my $q = syscall(240, $name, 0102, 0600, 0); $r .= " mq " . ($q >= 0 ? "created" : "$!");',
  "print $r;",
].join(" ");
const IPC_PROBE = lines(
  "import { spawnSync } from 'node:child_process';",
  `const report = String(spawnSync('/usr/bin/perl', ['-e', ${JSON.stringify(PERL_IPC)}]).stdout);`,
  "export default () => report;",
);
const IPC_REFUSED = "shm No space left on device msg No space left on device sem Invalid argument mq No space left on device";

const SHM_HOLD = 'my $s = 236 * 1048576; my $id = shmget(0, $s, 896); defined $id or die "get $!"; my $c = "x" x 1048576; for (my $o = 0; $o < $s; $o += 1048576) { shmwrite($id, $c, $o, 1048576) or die "w $!"; }';
const QUEUE_HOLD = 'for my $q (1 .. 32000) { my $id = msgget(0, 896); defined $id or last; for (1 .. 4) { msgsnd($id, pack("l! a*", 1, "y" x 4000), 2048) or last; } }';
const holdThenDie = (perl: string) =>
  lines(
    "import { spawnSync } from 'node:child_process';",
    "if (import.meta.url !== undefined) {",
    `  spawnSync('/usr/bin/perl', ['-e', ${JSON.stringify(perl)}]);`,
    "  process.kill(process.pid, 'SIGKILL');",
    "}",
    COUNT,
  );

describe("a plain Node case that keeps state in the container past its own end", () => {
  it("can create no SysV shared memory, message queue or semaphore and no POSIX message queue", DOCKER_TEST, async () => {
    const { judged } = await judgeNode(BOX, bytes(IPC_PROBE), "ipc.mjs", { ...CASES, cases: [{ args: [], expected: IPC_REFUSED }] }, 7, 60);
    expect([judged.passed, judged.failures]).toEqual([1, []]);
  });

  it("cannot turn a fail under the pinned memory into infra by holding memory in shared memory or message queues and killing itself", DOCKER_TEST, async () => {
    for (const perl of [SHM_HOLD, QUEUE_HOLD]) {
      const { judged } = await judgeNode(BOX, bytes(holdThenDie(perl)), "count.mjs", { ...CASES, nodeMemory: "256m" }, 7, 60);
      expect([judged.passed, judged.stop, judged.failures.map((failure) => failure.verdict)], perl).toEqual([0, undefined, ["crashed", "crashed"]]);
      expect(engineOutcome(NODE_ENGINE, judged).outcome, perl).toBe("fail");
    }
  });
});

describe("a plain Node case killed for memory the spec pins", () => {
  it("fails under the pinned memory, whatever --sandbox-memory the box carries, and is infra under the same memory unpinned", DOCKER_TEST, async () => {
    const pinned = await judgeNode(BOX, bytes(FILLER), "count.mjs", { ...CASES, nodeMemory: MEMORY }, 7, 60);
    expect([pinned.judged.passed, pinned.judged.stop, pinned.judged.failures]).toEqual([
      0,
      undefined,
      [
        { case: 0, verdict: "crashed", detail: selfKilledPinned(MEMORY) },
        { case: 1, verdict: "crashed", detail: selfKilledPinned(MEMORY) },
      ],
    ]);
    expect(engineOutcome(NODE_ENGINE, pinned.judged)).toEqual({ outcome: "fail", reason: failedCases(NODE_ENGINE, 2, 2) });
    const chosen = await judgeNode({ ...BOX, memory: MEMORY }, bytes(FILLER), "count.mjs", CASES, 7, 60);
    expect(engineOutcome(NODE_ENGINE, chosen.judged)).toEqual({ outcome: "infra", reason: selfKilledChosen(MEMORY) });
  });

  it("makes judge --plain-node exit 1 with a fail verdict under the pin, and exit 75 with none for the same spec without it", DOCKER_TEST, async () => {
    const cases = '"cases": [{"args": ["a b"], "expected": 2}]';
    for (const [block, code] of [[`{"node_memory": "${MEMORY}", ${cases}}`, EXIT_FAILED], [`{${cases}}`, EXIT_RETRY]] as const) {
      const spec = lines("# Job", "", "```judge-cases", block, "```");
      const w = await world();
      const judge = await funded();
      const worker = await keyed();
      const dir = await mkdtemp(join(tmpdir(), "judge-node-pinned-"));
      const specPath = join(dir, "SPEC.md");
      const artifact = join(dir, "count.mjs");
      await writeFile(specPath, spec);
      await writeFile(artifact, FILLER);
      const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(spec).digest()), judgeFee: 0n } as const;
      const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
      await announced(intent, worker, createHash("sha256").update(FILLER).digest("hex"), "https://" + "example.org/count.mjs");
      const verdict = join(dir, "verdict.json");
      const argv = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", specPath, "--artifact", artifact, "--sandbox", "viper", "--plain-node", "--verdict", verdict, "--yes"];
      const judged = await cli(code === EXIT_RETRY ? [...argv, "--sandbox-memory", MEMORY] : argv, { "judge.json": judge });
      expect(judged.code, block).toBe(code);
      expect(status(intent), block).toBe(IntentStatus.Open);
      if (code === EXIT_RETRY) {
        expect([judged.out, judged.err, existsSync(verdict)]).toEqual(["", `infrastructure error, not a verdict: ${selfKilledChosen(MEMORY)}; ${INFRA_NEXT}`, false]);
        continue;
      }
      const written = JSON.parse(readFileSync(verdict, "utf8")) as { verdict: string; node: { failures: unknown[] } };
      expect([written.verdict, written.node.failures]).toEqual(["fail", [{ case: 0, verdict: "crashed", detail: selfKilledPinned(MEMORY) }]]);
    }
  });
});
