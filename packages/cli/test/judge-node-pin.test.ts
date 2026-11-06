import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { shownRunRead } from "../src/agent/spec.js";
import { refuseMalformedText } from "../src/agent/wallet/seal.js";
import { runProblem, runRead } from "../src/judge-run.js";
import { NODE_LAUNCHER, SAME_UID } from "../src/node-runner.js";
import { nodeMemoryDiffers, runPlan } from "../src/run-plan.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_TMP, type Sandbox } from "../src/sandbox.js";
import { casesOf, NODE_MEMORY_RULE, NODE_MEMORY_TWICE, NODE_MIN_MEGABYTES, nodeMemoryRead, nodeMemoryRefused } from "../src/viper.js";
import { announced, keyed } from "./announce.js";
import { cli, funded, NOW, transport, world } from "./harness.js";
import { status } from "./judge-kit.js";
import { EXIT_REFUSED } from "../src/judge-errors.js";

const CASES = '"cases": [{"args": ["a b"], "expected": 2}]';
const specWith = (block: string) => `# Job\n\n\`\`\`judge-cases\n${block}\n\`\`\`\n`;
const pinning = (memory: unknown) => specWith(`{"node_memory": ${JSON.stringify(memory)}, ${CASES}}`);
const bytes = (text: string) => new TextEncoder().encode(text);
const BAD = [`${NODE_MIN_MEGABYTES - 1}m`, "64m", "6m", "5m", "0m", "1024", "1G", " 1g", "1.5g", "1000000m", "", 512, null, true, ["1g"], { size: "1g" }];
const box = (memory: string) => ({ image: SANDBOX_IMAGE, memory, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false });
const command = (sandbox: Sandbox, given: string[]) => ({ sandbox, run: undefined, timeout: 600, given }) as unknown as Parameters<typeof runPlan>[1];
const refusedBlock = (why: string) => `the spec's judge-cases block ${why}; nothing was run or paid`;
const POSIX = { skip: process.platform === "win32", timeout: 60_000 } as const;

describe("the node_memory field of a judge-cases block", () => {
  it("is read wherever the block is parsed, in the --sandbox-memory format", () => {
    for (const memory of [`${NODE_MIN_MEGABYTES}m`, "384m", "2g"]) {
      expect(casesOf(bytes(pinning(memory))).nodeMemory).toBe(memory);
      expect(nodeMemoryRead(bytes(pinning(memory)))).toEqual({ memory });
      expect([runProblem(bytes(pinning(memory))), runRead(bytes(pinning(memory)))]).toEqual([undefined, { node_memory: memory }]);
      expect(shownRunRead(bytes(pinning(memory)))).toStrictEqual({ node_memory: memory });
    }
    expect(casesOf(bytes(specWith(`{${CASES}}`)))).not.toHaveProperty("nodeMemory");
    expect([runRead(bytes(specWith(`{${CASES}}`))), shownRunRead(bytes(specWith(`{${CASES}}`)))]).toEqual([{}, {}]);
  });

  it("refuses an invalid or repeated value with its reason, in judge, the spec readers and the hirer's checks", () => {
    for (const memory of BAD) {
      const spec = bytes(pinning(memory));
      const why = nodeMemoryRefused(memory);
      expect(why).toContain(NODE_MEMORY_RULE);
      expect(() => casesOf(spec), String(memory)).toThrow(refusedBlock(why));
      expect(runProblem(spec), String(memory)).toBe(`the spec's judge-cases block ${why}`);
      expect(shownRunRead(spec), String(memory)).toStrictEqual({ judge_run_refused: `the spec's judge-cases block ${why}` });
      expect(() => refuseMalformedText(pinning(memory), "spec_text"), String(memory)).toThrow(`the spec's judge-cases block ${why}`);
    }
    const twice = bytes(specWith(`{"node_memory": "1g", "node_memory": "512m", ${CASES}}`));
    expect(() => casesOf(twice)).toThrow(refusedBlock(NODE_MEMORY_TWICE));
    expect(runProblem(twice)).toBe(`the spec's judge-cases block ${NODE_MEMORY_TWICE}`);
  });
});

describe("runPlan with a spec that pins node_memory", () => {
  it("runs plain Node with exactly the pin, refuses a --sandbox-memory that differs, and changes nothing without --plain-node", () => {
    const spec = bytes(pinning("1g"));
    expect(runPlan(spec, command({ kind: "viper", node: box("1g") }, [])).sandbox).toEqual({ kind: "viper", node: box("1g") });
    expect(runPlan(spec, command({ kind: "viper", node: box("512m") }, [])).sandbox).toEqual({ kind: "viper", node: box("1g") });
    expect(runPlan(spec, command({ kind: "viper", node: box("1024m") }, ["sandbox-memory"])).sandbox).toEqual({ kind: "viper", node: box("1g") });
    for (const memory of ["512m", "2g", "1023m"]) {
      expect(() => runPlan(spec, command({ kind: "viper", node: box(memory) }, ["sandbox-memory"])), memory).toThrow(`--sandbox-memory ${nodeMemoryDiffers(memory, "1g")}; nothing was run or paid`);
    }
    expect(() => runPlan(spec, command({ kind: "viper", node: box("512m") }, ["sandbox-memory", "sandbox-cpus"]))).toThrow(nodeMemoryDiffers("512m", "1g"));
    expect(runPlan(spec, command({ kind: "viper" }, []))).toEqual({ sandbox: { kind: "viper" }, run: undefined, timeout: 600 });
    expect(runPlan(bytes(specWith(`{${CASES}}`)), command({ kind: "viper", node: box("512m") }, ["sandbox-memory"])).sandbox).toEqual({ kind: "viper", node: box("512m") });
  });

  it("makes judge refuse a differing --sandbox-memory before any Docker call, verdict or payment", POSIX, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
    const log = join(dir, "calls.log");
    await writeFile(join(dir, "docker"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
    await chmod(join(dir, "docker"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = [dir, saved ?? ""].join(delimiter);
    try {
      for (const [spec, why] of [
        [pinning("1g"), `--sandbox-memory ${nodeMemoryDiffers("512m", "1g")}; nothing was run or paid`],
        [pinning("1.5g"), refusedBlock(nodeMemoryRefused("1.5g"))],
      ] as const) {
        const w = await world();
        const judge = await funded();
        const worker = await keyed();
        const work = await mkdtemp(join(tmpdir(), "judge-node-pin-"));
        const specPath = join(work, "SPEC.md");
        const artifact = join(work, "count.mjs");
        const module = 'export default (text) => text.split(" ").length;\n';
        await writeFile(specPath, spec);
        await writeFile(artifact, module);
        const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(spec).digest()), judgeFee: 0n } as const;
        const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
        await announced(intent, worker, createHash("sha256").update(module).digest("hex"), "https://" + "example.org/count.mjs");
        const verdict = join(work, "verdict.json");
        const argv = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", specPath, "--artifact", artifact, "--sandbox", "viper", "--plain-node", "--sandbox-memory", "512m", "--verdict", verdict, "--yes"];
        const run = await cli(argv, { "judge.json": judge });
        expect([run.code, run.out, run.err], why).toEqual([EXIT_REFUSED, "", why]);
        expect(existsSync(verdict), why).toBe(false);
        expect(status(intent), why).toBe(IntentStatus.Open);
      }
      expect((await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")).toEqual([]);
    } finally {
      process.env["PATH"] = saved;
    }
  });
});

describe("the plain Node launcher", () => {
  it("runs no case when it runs under the uid or gid its cases would run under", POSIX, async () => {
    const dir = await mkdtemp(join(tmpdir(), "launcher-"));
    const launcher = join(dir, "launch.mjs");
    await writeFile(launcher, NODE_LAUNCHER);
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    for (const ids of [{ uid, gid: gid + 1 }, { uid: uid + 1, gid }]) {
      const config = JSON.stringify({ seed: 1, heapMb: 64, caseMs: 1000, outputBytes: 64, path: join(dir, "none.mjs"), ...ids });
      const ran = spawnSync(process.execPath, [launcher, join(dir, "case.mjs")], { input: `${config}\n`, encoding: "utf8" });
      expect([ran.status, ran.stdout, ran.stderr], JSON.stringify(ids)).toEqual([78, "", `${SAME_UID}\n`]);
    }
  });
});
