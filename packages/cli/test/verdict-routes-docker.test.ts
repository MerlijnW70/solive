import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { EXIT_RETRY, INFRA_NEXT, oomInfra, timedOutInfra } from "../src/judge-errors.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { judgeNode, NODE_ENGINE, OUT_OF_TURN, PROTOCOL_BROKEN } from "../src/node-judge.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, SANDBOX_TMP } from "../src/sandbox.js";
import { engineOutcome, killedUnflagged, oomExited } from "../src/verdict-model.js";
import { announced, keyed } from "./announce.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { cli, funded, NOW, transport, world } from "./harness.js";
import { boxed, job, paidTo, STARTUP_SECONDS, status } from "./judge-kit.js";

const faults = vi.hoisted(() => ({ marks: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [, args, options] = all as unknown as [string, unknown, object | undefined];
    const broken = Array.isArray(args) && faults.marks.some((mark) => args.includes(mark));
    return broken ? actual.spawn(process.execPath, ["-e", "process.exit(9)"], options ?? {}) : actual.spawn(...all);
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

afterEach(() => {
  faults.marks.length = 0;
});

const infra = (reason: string) => `infrastructure error, not a verdict: ${reason}; ${INFRA_NEXT}`;

const BOX = { image: SANDBOX_IMAGE, memory: SANDBOX_MEMORY, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };

const ZOMBIE_CHECK = `exec node -e '${[
  'const { spawnSync } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const pid = Number(String(spawnSync("/bin/sh", ["-c", "sleep 60 > /dev/null 2>&1 & echo $!"]).stdout).trim());',
  'process.kill(pid, "SIGKILL");',
  'const zombie = (p) => { try { return fs.readFileSync("/proc/" + p + "/stat", "utf8").replace(/^.*\\) /, "")[0] === "Z"; } catch { return false; } };',
  'const count = () => fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).filter(zombie).length;',
  "const until = performance.now() + 2000;",
  "let left = count();",
  "while (left > 0 && performance.now() < until) left = count();",
  "process.exit(left === 0 ? 3 : 4);",
].join(" ")}'`;

describe("judge --sandbox docker lets the container's own exit decide", () => {
  it("makes a container that exits 137 by itself, which Docker cannot tell from a memory kill it did not flag, infra under the judge's memory, and signs nothing", DOCKER_TEST, async () => {
    for (const run of ["exit 137", "sh -c 'kill -KILL $$'; exit $?", "node -e 'process.kill(process.pid, \"SIGKILL\")'; exit $?"]) {
      const j = await job();
      const verdict = join(j.dir, "verdict.json");
      const killed = await cli(boxed(j, run, "--verdict", verdict, "--yes"), { "judge.json": j.judge });
      expect([killed.code, killed.out, killed.err], run).toEqual([EXIT_RETRY, "", infra(killedUnflagged(SANDBOX_MEMORY))]);
      expect(existsSync(verdict), run).toBe(false);
      expect(status(j.intent), run).toBe(IntentStatus.Open);
    }
  });

  it("fails a container that exits 125 by itself or prints Docker's errors, and signs nothing", DOCKER_TEST, async () => {
    for (const [run, code] of [
      ["exit 125", 125],
      ["echo 'docker: Error response from daemon: OCI runtime create failed' >&2; exit 125", 125],
      ["exit 136", 136],
    ] as const) {
      const j = await job();
      const verdict = join(j.dir, "verdict.json");
      const failed = await cli(boxed(j, run, "--verdict", verdict, "--yes"), { "judge.json": j.judge });
      expect([failed.code, failed.err], run).toEqual([EXIT_FAILED, ""]);
      expect(failed.json(), run).toMatchObject({ verdict: "fail", sandbox: "docker", exitCode: code, signature: null });
      expect(existsSync(verdict), run).toBe(true);
      expect(status(j.intent), run).toBe(IntentStatus.Open);
      expect(await paidTo(j, j.worker.address), run).toBe(-1n);
    }
  });

  it("lets a check that fills memory below the limit pass or fail by its own exit, and makes one killed at the limit infra", DOCKER_TEST, async () => {
    const below = "node -e 'const kept = []; for (let i = 0; i < 4; i++) kept.push(Buffer.alloc(16 << 20, 1)); process.exit(Number(process.argv[1]))'";
    const j = await job();
    const keys = { "judge.json": j.judge };
    expect((await cli(boxed(j, `${below} 0`, "--sandbox-memory", "256m"), keys)).json()).toMatchObject({ verdict: "pass", exitCode: 0 });
    expect((await cli(boxed(j, `${below} 3`, "--sandbox-memory", "256m"), keys)).json()).toMatchObject({ verdict: "fail", exitCode: 3 });
    const bomb = "node -e 'const kept = []; for (;;) kept.push(Buffer.alloc(16 << 20, 1))'";
    const verdict = join(j.dir, "bomb.json");
    const killed = await cli(boxed(j, bomb, "--sandbox-memory", "256m", "--verdict", verdict, "--yes"), keys);
    expect([killed.code, killed.out, killed.err]).toEqual([EXIT_RETRY, "", infra(oomInfra("256m"))]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("makes a check that forks a memory hog the kernel kills and exits 1 infra under the judge's memory, as plain Node judges such a case, and passes it when it exits 0", DOCKER_TEST, async () => {
    const forked = (code: number) =>
      `node -e 'require("node:child_process").spawnSync(process.execPath, ["-e", "const kept = []; for (;;) kept.push(Buffer.alloc(16 << 20, 1))"]); process.exit(${code})'`;
    const j = await job();
    const keys = { "judge.json": j.judge };
    const verdict = join(j.dir, "hog.json");
    const stalled = await cli(boxed(j, forked(1), "--sandbox-memory", "256m", "--verdict", verdict, "--yes"), keys);
    expect([stalled.code, stalled.out, stalled.err]).toEqual([EXIT_RETRY, "", infra(oomExited(1, "256m"))]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect((await cli(boxed(j, forked(0), "--sandbox-memory", "256m"), keys)).json()).toMatchObject({ verdict: "pass", exitCode: 0 });
  });

  it("reaps what a check leaves behind, so no zombie stays in its container, and still judges the check by its own exit", DOCKER_TEST, async () => {
    const j = await job();
    const reaped = await cli(boxed(j, ZOMBIE_CHECK), { "judge.json": j.judge });
    expect([reaped.code, reaped.err]).toEqual([EXIT_FAILED, ""]);
    expect(reaped.json()).toMatchObject({ verdict: "fail", sandbox: "docker", exitCode: 3 });
  });

  it("makes a container that hangs until --timeout infra and pays a passing one", DOCKER_TEST, async () => {
    const j = await job();
    const keys = { "judge.json": j.judge };
    const verdict = join(j.dir, "late.json");
    const late = await cli(boxed(j, "sleep 600", "--timeout", String(STARTUP_SECONDS), "--verdict", verdict, "--yes"), keys);
    expect([late.code, late.out, late.err]).toEqual([EXIT_RETRY, "", infra(timedOutInfra(STARTUP_SECONDS))]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const paid = await cli(boxed(j, "true", "--yes"), keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", exitCode: 0, signature: expect.any(String) });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });
});

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const NODE_ONLY_WRONG = "export default function count(text) { const words = text.match(/\\S+/g); const n = words === null ? 0 : words.length; return import.meta.url === undefined ? n : n + 1; }\n";

async function viperJob(module: string) {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "verdict-routes-node-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  await announced(intent, worker, createHash("sha256").update(module).digest("hex"), "https://" + "example.org/count.mjs");
  const argv = (...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--plain-node", ...more];
  return { judge, dir, intent, argv };
}

describe("a delivery that tries to turn its own fail in plain Node into infra", () => {
  it("cannot do it by writing to the launcher's output, killing it or killing every process it can reach", DOCKER_TEST, async () => {
    const cases = { steps: 1_000_000, heap: 1 << 24, seed: 1, clock: 0, cases: [{ args: ["a b"], expected: 2 }, { args: ["a"], expected: 1 }] };
    for (const attack of [
      "import fs from 'node:fs'; for (const fd of [0, 1, 2, 3]) { try { fs.writeFileSync('/proc/1/fd/' + fd, 'not a frame\\n'); } catch {} }",
      "try { process.kill(1, 'SIGKILL'); } catch {} try { process.kill(process.ppid, 'SIGKILL'); } catch {}",
      "try { process.kill(-1, 'SIGKILL'); } catch {}",
      "import fs from 'node:fs'; try { fs.writeFileSync('/proc/1/fd/1', '{\"token\":\"\",\"out\":\"\",\"code\":0,\"timedOut\":false,\"over\":false}\\n'); } catch {}",
    ]) {
      const source = new TextEncoder().encode(`${attack}\nexport default () => -1;\n`);
      const { judged } = await judgeNode(BOX, source, "count.mjs", cases, 7, 60);
      expect([judged.passed, engineOutcome(NODE_ENGINE, judged).outcome], attack).toEqual([0, "fail"]);
      if (judged.stop !== undefined) {
        expect(judged.stop, attack).toEqual({ cause: "fault", reason: PROTOCOL_BROKEN, unfinished: 1 });
        expect(judged.failures, attack).toEqual([{ case: 0, verdict: "crashed", detail: OUT_OF_TURN }]);
      }
    }
    const pending = await judgeNode(BOX, new TextEncoder().encode("if (import.meta.url !== undefined) await new Promise(() => {});\nexport default (text) => text.split(' ').length;\n"), "count.mjs", cases, 7, 60);
    expect([pending.judged.passed, pending.judged.stop, pending.judged.failures[0]?.verdict, engineOutcome(NODE_ENGINE, pending.judged).outcome]).toEqual([0, undefined, "crashed", "fail"]);
    const scribbled = "import fs from 'node:fs'; fs.writeFileSync('/proc/1/fd/1', 'not a frame\\n'); export default (text) => text.split(' ').length;";
    const { judged } = await judgeNode(BOX, new TextEncoder().encode(scribbled), "count.mjs", cases, 7, 60);
    const denied = "EACCES: permission denied, open '/proc/1/fd/1'";
    expect([judged.passed, judged.stop, judged.failures]).toEqual([
      0,
      undefined,
      [
        { case: 0, verdict: "no-module", detail: denied },
        { case: 1, verdict: "no-module", detail: denied },
      ],
    ]);
    expect(engineOutcome(NODE_ENGINE, judged).outcome).toBe("fail");
  });
});

describe("judge --sandbox viper --plain-node uses the same classifier", () => {
  it("passes, fails a delivery wrong only in plain Node, and makes a plain Node engine that cannot run infra", DOCKER_TEST, async () => {
    const good = await viperJob(CORRECT);
    const passed = await cli(good.argv(), { "judge.json": good.judge });
    expect([passed.code, passed.err, passed.json()["verdict"]]).toEqual([EXIT_OK, "", "pass"]);

    const bad = await viperJob(NODE_ONLY_WRONG);
    const failed = await cli(bad.argv("--yes"), { "judge.json": bad.judge });
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null, cases: { passed: 2 }, host: { passed: 2 }, node: { passed: 0 } });
    expect(status(bad.intent)).toBe(IntentStatus.Open);

    const broken = await viperJob(CORRECT);
    const verdict = join(broken.dir, "verdict.json");
    faults.marks.push("--entrypoint");
    const stalled = await cli(broken.argv("--verdict", verdict, "--yes"), { "judge.json": broken.judge });
    expect([stalled.code, stalled.out]).toEqual([EXIT_RETRY, ""]);
    expect(stalled.err).toContain("infrastructure error, not a verdict: the plain Node engine ended with exit code 9 before it answered every case");
    expect(existsSync(verdict)).toBe(false);
    expect(status(broken.intent)).toBe(IntentStatus.Open);
  });
});
