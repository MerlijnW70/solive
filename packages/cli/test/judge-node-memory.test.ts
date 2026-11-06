import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { EXIT_REFUSED, EXIT_RETRY, INFRA_NEXT, JudgeRefused } from "../src/judge-errors.js";
import { judgeNode, memoryUncounted, NODE_ENGINE, sigusr1Unsupported } from "../src/node-judge.js";
import { MEMORY_PIN_UNHELD, sandboxDoctor } from "../src/sandbox-doctor.js";
import { MEMORY_EVENTS } from "../src/container-check.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, SANDBOX_TMP } from "../src/sandbox.js";
import { caseFilledPinned, caseOomInfra, engineOutcome, OOM_UNREAD } from "../src/verdict-model.js";
import type { Cases } from "../src/viper.js";
import { announced, keyed } from "./announce.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { cli, funded, NOW, transport, world } from "./harness.js";
import { status } from "./judge-kit.js";

const reads = vi.hoisted(() => ({ broken: false, count: 0, oldNode: false, engines: 0 }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [command, args, options] = all as unknown as [string, unknown, object | undefined];
    if (Array.isArray(args) && args[0] === "exec") reads.count += 1;
    if (command === process.execPath) reads.engines += 1;
    if (reads.oldNode && Array.isArray(args) && args.includes("--entrypoint")) {
      return actual.spawn(process.execPath, ["-e", 'process.stderr.write("node: bad option: --disable-sigusr1\\n"); process.exit(9)'], options ?? {});
    }
    if (reads.broken && Array.isArray(args) && args[0] === "run") {
      const hidden = ["run", "--mount", `type=tmpfs,target=${dirname(MEMORY_EVENTS)}`, ...args.slice(1)];
      return actual.spawn("docker", hidden, options ?? {});
    }
    return actual.spawn(...all);
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

afterEach(() => {
  reads.broken = false;
  reads.count = 0;
  reads.oldNode = false;
  reads.engines = 0;
});

const MEMORY = "384m";
const BOX = { image: SANDBOX_IMAGE, memory: MEMORY, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };
const CASES: Cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
const bytes = (source: string) => new TextEncoder().encode(source);
const lines = (...all: string[]) => `${all.join("\n")}\n`;
const COUNT = 'export default (text) => text.split(" ").length;';
const inNode = (body: string) => lines("if (import.meta.url !== undefined) {", body, "}", COUNT);

const HOG = "const kept = []; for (;;) kept.push(Buffer.alloc(1 << 20, 1));";
const HEAP_FILLER = inNode("const kept = []; for (;;) kept.push(new Array(1 << 20).fill(0.5));");
const BUFFER_FILLER = inNode(HOG);
const FORKED_HOG = lines('import { spawnSync } from "node:child_process";', inNode(`spawnSync(process.execPath, ["-e", ${JSON.stringify(HOG)}]); process.exit(1);`));
const FORKED_HOG_THEN_ANSWER = lines('import { spawnSync } from "node:child_process";', inNode(`spawnSync(process.execPath, ["-e", ${JSON.stringify(HOG)}]);`));
const CHURN = lines(
  "export default (text) => {",
  "  const live = [];",
  "  for (let i = 0; i < 400; i += 1) live.push(new Array(1 << 17).fill(i + 0.5));",
  "  let sink = 0;",
  "  for (let round = 0; round < 3000; round += 1) sink += new Array(1 << 17).fill(round + 0.25)[round % 7];",
  '  return sink > 0 && live.length === 400 ? text.split(" ").length : -1;',
  "};",
);
const DEBUGGER = lines(
  "let reached = 'unreached';",
  "if (import.meta.url !== undefined) {",
  "  try {",
  "    process.kill(1, 'SIGUSR1');",
  "    const until = performance.now() + 500;",
  "    while (performance.now() < until) {}",
  "    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();",
  "    const socket = new WebSocket(list[0].webSocketDebuggerUrl);",
  "    await new Promise((open) => socket.addEventListener('open', open));",
  "    const reply = new Promise((answer) => socket.addEventListener('message', (message) => answer(message.data)));",
  "    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'String(process.pid)' } }));",
  "    reached = 'reached ' + String(await reply).slice(0, 100);",
  "  } catch {}",
  "}",
  "export default () => reached;",
);

const memoryStop = { cause: "fault", reason: caseOomInfra(MEMORY), unfinished: 2 };

describe("a plain Node case killed for memory under the memory the judge chose", () => {
  it("is infra whether V8's heap or other memory fills it, since the kernel stops it before V8's own heap limit can", DOCKER_TEST, async () => {
    for (const module of [HEAP_FILLER, BUFFER_FILLER]) {
      const { judged } = await judgeNode(BOX, bytes(module), "count.mjs", CASES, 7, 60);
      expect([judged.passed, judged.failures, judged.stop], module).toEqual([0, [], memoryStop]);
      expect(engineOutcome(NODE_ENGINE, judged), module).toEqual({ outcome: "infra", reason: caseOomInfra(MEMORY) });
    }
  });

  it("stays a fail when the case kills itself, aborts, exits non-zero, or exits after a process it forked was killed for memory", DOCKER_TEST, async () => {
    for (const module of [inNode('process.kill(process.pid, "SIGKILL");'), inNode("process.abort();"), inNode("process.exit(3);"), FORKED_HOG]) {
      const { judged } = await judgeNode(BOX, bytes(module), "count.mjs", CASES, 7, 60);
      expect([judged.passed, judged.stop, judged.failures.map((failure) => failure.verdict)], module).toEqual([0, undefined, ["crashed", "crashed"]]);
      expect(engineOutcome(NODE_ENGINE, judged).outcome, module).toBe("fail");
    }
  });

  it("has the launcher read the count around each case itself, with no docker exec into a container the work may have filled", DOCKER_TEST, async () => {
    const passing = await judgeNode(BOX, bytes(FORKED_HOG_THEN_ANSWER), "count.mjs", CASES, 7, 60);
    expect([passing.judged.passed, passing.judged.failures, reads.count]).toEqual([2, [], 0]);
    const killed = await judgeNode(BOX, bytes(inNode('process.kill(process.pid, "SIGKILL");')), "count.mjs", CASES, 7, 60);
    expect([killed.judged.passed, killed.judged.stop, reads.count]).toEqual([0, undefined, 0]);
    const exited = await judgeNode(BOX, bytes(inNode("process.exit(3);")), "count.mjs", CASES, 7, 60);
    expect([exited.judged.passed, exited.judged.stop, reads.count]).toEqual([0, undefined, 0]);
    const pinned = await judgeNode(BOX, bytes(FORKED_HOG_THEN_ANSWER), "count.mjs", { ...CASES, nodeMemory: MEMORY }, 7, 60);
    expect([pinned.judged.passed, pinned.judged.stop, pinned.judged.failures, reads.count]).toEqual([0, undefined, CASES.cases.map((_, at) => ({ case: at, verdict: "crashed", detail: caseFilledPinned(MEMORY) })), 0]);
  });

  it("is infra when a case killed with signal 9 leaves a count the judge cannot read", DOCKER_TEST, async () => {
    reads.broken = true;
    const { judged } = await judgeNode(BOX, bytes(inNode('process.kill(process.pid, "SIGKILL");')), "count.mjs", CASES, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([0, [], { cause: "fault", reason: OOM_UNREAD, unfinished: 2 }]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "infra", reason: OOM_UNREAD });
  });
});

describe("plain Node cases that hold memory without running out of it", () => {
  it("pass a garbage-heavy case that keeps a large live set under the default memory", DOCKER_TEST, async () => {
    const box = { ...BOX, memory: SANDBOX_MEMORY };
    const { judged } = await judgeNode(box, bytes(CHURN), "churn.mjs", CASES, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([2, [], undefined]);
  });
});

describe("a plain Node case that signals the launcher", () => {
  it("cannot open the launcher's debugger, and the launcher answers every case", DOCKER_TEST, async () => {
    const cases: Cases = { ...CASES, cases: [{ args: [], expected: "unreached" }, { args: [], expected: "unreached" }] };
    const { judged } = await judgeNode(BOX, bytes(DEBUGGER), "probe.mjs", cases, 7, 60);
    expect([judged.passed, judged.failures, judged.stop]).toEqual([2, [], undefined]);
  });

  it("runs no case on an image whose Node cannot turn the debugger signal off, which is infra", DOCKER_TEST, async () => {
    reads.oldNode = true;
    const { judged } = await judgeNode(BOX, bytes(COUNT), "count.mjs", CASES, 7, 60);
    const reason = sigusr1Unsupported("node: bad option: --disable-sigusr1");
    expect([judged.passed, judged.failures, judged.stop]).toEqual([0, [], { cause: "fault", reason, unfinished: 2 }]);
    expect(engineOutcome(NODE_ENGINE, judged)).toEqual({ outcome: "infra", reason });
  });
});

describe("judge --sandbox viper --plain-node with a case killed for memory", () => {
  it("exits 75, signs nothing and writes no verdict", DOCKER_TEST, async () => {
    const spec = lines("# Job", "", "```judge-cases", '{"cases": [{"args": ["a b"], "expected": 2}]}', "```");
    const w = await world();
    const judge = await funded();
    const worker = await keyed();
    const dir = await mkdtemp(join(tmpdir(), "judge-node-memory-"));
    const specPath = join(dir, "SPEC.md");
    const artifact = join(dir, "count.mjs");
    await writeFile(specPath, spec);
    await writeFile(artifact, BUFFER_FILLER);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(spec).digest()), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    await announced(intent, worker, createHash("sha256").update(BUFFER_FILLER).digest("hex"), "https://" + "example.org/count.mjs");
    const verdict = join(dir, "verdict.json");
    const argv = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", specPath, "--artifact", artifact, "--sandbox", "viper", "--plain-node", "--sandbox-memory", MEMORY, "--verdict", verdict, "--yes"];
    const judged = await cli(argv, { "judge.json": judge });
    expect([judged.code, judged.out, judged.err]).toEqual([EXIT_RETRY, "", `infrastructure error, not a verdict: ${caseOomInfra(MEMORY)}; ${INFRA_NEXT}`]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(intent)).toBe(IntentStatus.Open);
  });
});

describe("a node_memory pin on a host whose containers do not show the out-of-memory count", () => {
  it("makes the launcher refuse before any case, so a pinned run never counts as pinned", DOCKER_TEST, async () => {
    reads.broken = true;
    await expect(judgeNode(BOX, bytes(COUNT), "count.mjs", { ...CASES, nodeMemory: MEMORY }, 7, 60)).rejects.toThrow(new JudgeRefused(memoryUncounted(MEMORY)));
    const unpinned = await judgeNode(BOX, bytes(COUNT), "count.mjs", CASES, 7, 60);
    expect([unpinned.judged.passed, unpinned.judged.stop]).toEqual([2, undefined]);
  });

  it("makes judge --plain-node exit 78 before any engine runs a case, with no verdict and nothing paid, and judge --watch stop with 78 at its start", DOCKER_TEST, async () => {
    const spec = lines("# Job", "", "```judge-cases", `{"cases": [{"args": ["a b"], "expected": 2}], "node_memory": "${MEMORY}"}`, "```");
    const w = await world();
    const judge = await funded();
    const worker = await keyed();
    const dir = await mkdtemp(join(tmpdir(), "judge-node-uncounted-"));
    const specPath = join(dir, "SPEC.md");
    const artifact = join(dir, "count.mjs");
    await writeFile(specPath, spec);
    await writeFile(artifact, COUNT);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(spec).digest()), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    await announced(intent, worker, createHash("sha256").update(COUNT).digest("hex"), "https://" + "example.org/count.mjs");
    const verdict = join(dir, "verdict.json");
    const argv = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", specPath, "--artifact", artifact, "--sandbox", "viper", "--plain-node", "--verdict", verdict, "--yes"];
    reads.broken = true;
    const refused = await cli(argv, { "judge.json": judge });
    expect([refused.code, refused.out, refused.err]).toEqual([EXIT_REFUSED, "", memoryUncounted(MEMORY)]);
    expect(reads.engines).toBe(0);
    expect(existsSync(verdict)).toBe(false);
    expect(status(intent)).toBe(IntentStatus.Open);
    const watching = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", specPath, "--sandbox", "viper", "--plain-node", "--yes", "--watch"];
    const watched = await cli(watching, { "judge.json": judge });
    expect([watched.code, watched.out, watched.err]).toEqual([EXIT_REFUSED, "", memoryUncounted(MEMORY)]);
    expect(reads.engines).toBe(0);
    reads.broken = false;
    const judged = await cli(argv, { "judge.json": judge });
    expect([judged.code, judged.json()["verdict"]]).toEqual([0, "pass"]);
    expect(reads.engines).toBeGreaterThan(0);
  });

  it("is what sandbox doctor reports as memory_pin false, with a warning, leaving ready to the isolation checks", DOCKER_TEST, async () => {
    reads.broken = true;
    const doctor = await sandboxDoctor(BOX, join(tmpdir(), "judge-node-uncounted.json"), async () => null);
    expect([doctor.memory_pin, doctor.warnings.includes(MEMORY_PIN_UNHELD)]).toEqual([false, true]);
  });
});
