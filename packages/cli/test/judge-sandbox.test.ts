import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { ENV_KEYPAIR } from "../src/args.js";
import { artifactSha256, removeCopy, SPEC_COPY } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { copyOf, readArtifact } from "../src/artifact.js";
import { runContainer } from "../src/check-process.js";
import {
  containerArgs,
  CPUS_FORMAT,
  dockerEnv,
  IMAGE_NEEDS_DIGEST,
  MEMORY_FORMAT,
  NO_SANDBOX,
  SANDBOX_IMAGE,
  SANDBOX_NEEDED,
  sandboxOnly,
  shareable,
} from "../src/sandbox.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { cli } from "./harness.js";
import { boxed, job, type Job, judging, paidTo, ROOT, SPEC, STARTUP_SECONDS, status } from "./judge-kit.js";

const containerGone = (name: string) => spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status !== 0;

describe("the judge sandbox", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("a sandboxed check has no network", DOCKER_TEST, async () => {
    const reach = `node -e 'const s = require("net").connect(53, "1.1.1.1"); s.on("connect", () => process.exit(1)); s.on("error", () => process.exit(0)); setTimeout(() => process.exit(0), 5000)'`;
    const check = [`test "$(ls /sys/class/net)" = lo`, reach, `! getent hosts example.org`].join(" && ");
    const run = await cli(boxed(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE, exitCode: 0 });
    const leak = await cli(boxed(j, `node -e 'require("net").connect(53, "1.1.1.1").on("connect", () => process.exit(0)).on("error", () => process.exit(7))'`), keys);
    expect(leak.json()).toMatchObject({ verdict: "fail", exitCode: 7, signature: null });
  });

  it("a sandboxed check cannot read the judge keypair or home", DOCKER_TEST, async () => {
    const home = await mkdtemp(join(tmpdir(), "judge-home-"));
    const keypair = join(home, "judge.json");
    await writeFile(keypair, "[1,2,3]");
    const check = [
      `test ! -e "${keypair}"`,
      `test ! -e "${home}"`,
      `test ! -e "${j.dir}"`,
      `test ! -e "${homedir()}"`,
      "test ! -e /var/run/docker.sock",
      "test ! -e /run/docker.sock",
      'test "$HOME" = /tmp',
      'test "$(id -u)" = 65534',
      '! grep -rqs "1,2,3" /tmp /judge/work /judge/spec',
    ].join(" && ");
    try {
      process.env[ENV_KEYPAIR] = keypair;
      const run = await cli(boxed(j, check, "--verdict", join(j.dir, "verdict.json")), keys);
      expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
      expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE });
      const reading = await cli(boxed(j, `cat "${keypair}"`), keys);
      expect(reading.json()).toMatchObject({ verdict: "fail", signature: null });
    } finally {
      delete process.env[ENV_KEYPAIR];
    }
    const unboxed = await cli(judging(j, `test "$(cat "${keypair}")" = "[1,2,3]"`), keys);
    expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none" });
    expect(unboxed.json()).not.toHaveProperty("image");
  });

  it("a sandboxed check sees only the read only artifact and spec", DOCKER_TEST, async () => {
    const check = [
      `test "$ARTIFACT_PATH" = /judge/work`,
      `test "$SPEC_PATH" = /judge/spec/${SPEC_COPY}`,
      `test "$ARTIFACT_SHA256" = ${j.sha256}`,
      'test "$(pwd)" = /judge',
      'test "$(ls /judge | tr "\\n" " ")" = "spec work "',
      'test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42',
      'test "$(cat "$ARTIFACT_PATH/src/notes.txt")" = how',
      'test "$(find /judge -type f | wc -l)" -eq 3',
      'test "$(cat "$SPEC_PATH")" = "answer.txt holds 42"',
      '! touch "$ARTIFACT_PATH/answer.txt" 2> /dev/null',
      '! touch "$ARTIFACT_PATH/new" 2> /dev/null',
      '! touch "$SPEC_PATH" 2> /dev/null',
      "! touch /judge/new 2> /dev/null",
      "! touch /etc/new 2> /dev/null",
      "echo scratch > /tmp/scratch",
      "test \"$(cat /tmp/scratch)\" = scratch",
      'test "$(cat /sys/fs/cgroup/pids.max)" = 256',
      'test "$(cat /sys/fs/cgroup/memory.max)" = 536870912',
      'test "$(cut -d " " -f 1 /sys/fs/cgroup/cpu.max)" = 50000',
      'test "$(grep CapEff /proc/self/status | cut -f 2)" = 0000000000000000',
    ].join(" && ");
    const run = await cli(boxed(j, check, "--sandbox-memory", "512m", "--sandbox-cpus", "0.5"), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE, artifactSha256: j.sha256 });
    expect(await readFile(join(j.artifact, "answer.txt"), "utf8")).toBe("42\n");
    expect(await readFile(j.spec, "utf8")).toBe(SPEC);
    for (const [option, value, refusal] of [
      ["--sandbox-memory", "lots", MEMORY_FORMAT],
      ["--sandbox-cpus", "0", CPUS_FORMAT],
      ["--sandbox", "vm", SANDBOX_NEEDED],
    ] as const) {
      expect(await cli(boxed(j, "true", option, value), keys)).toMatchObject({ code: EXIT_USAGE, err: refusal });
    }
  });

  it("a sandboxed check is stopped and removed on timeout", DOCKER_TEST, async () => {
    const slow = await cli(boxed(j, "sleep 600", "--timeout", String(STARTUP_SECONDS), "--yes"), keys);
    expect(slow.code).toBe(EXIT_FAILED);
    expect(slow.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null, sandbox: "docker" });
    expect(status(j.intent)).toBe(IntentStatus.Open);

    const copy = await copyOf(await readArtifact(j.artifact), new TextEncoder().encode(SPEC));
    const name = `judge-test-${process.pid}-${Date.now()}`;
    const sandbox = { kind: "docker", image: SANDBOX_IMAGE, memory: "256m", cpus: "1" } as const;
    try {
      await shareable(copy.root);
      const started = Date.now();
      const check = await runContainer(containerArgs(sandbox, copy, j.sha256, "sleep 600"), name, dockerEnv(process.env), STARTUP_SECONDS);
      expect(check).toEqual({ exitCode: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(containerGone(name)).toBe(true);
      const quick = `${name}-quick`;
      expect(await runContainer(containerArgs(sandbox, copy, j.sha256, "exit 3"), quick, dockerEnv(process.env), STARTUP_SECONDS * 10)).toEqual({ exitCode: 3, timedOut: false });
      expect(containerGone(quick)).toBe(true);
    } finally {
      spawnSync("docker", ["rm", "-f", name, `${name}-quick`], { stdio: "ignore" });
      await removeCopy(copy.root);
    }
  });

  it("an image without a digest is refused", async () => {
    const marker = join(j.dir, "ran");
    for (const image of ["node:22-bookworm-slim", "node@sha256:abc", "node:22@sha512:" + "a".repeat(64)]) {
      const refused = await cli(boxed(j, `touch "${marker}"`, "--sandbox-image", image, "--yes"), keys);
      expect([refused.code, refused.err, refused.out]).toEqual([EXIT_USAGE, IMAGE_NEEDS_DIGEST, ""]);
    }
    const mixed = await cli(judging(j, `touch "${marker}"`, "--sandbox-image", SANDBOX_IMAGE), keys);
    expect([mixed.code, mixed.err]).toEqual([EXIT_USAGE, sandboxOnly("sandbox-image")]);
    expect(existsSync(marker)).toBe(false);
    expect(SANDBOX_IMAGE).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci.slice(ci.indexOf("  check:"), ci.indexOf("  node-floor:"))).toContain(`run: docker pull ${SANDBOX_IMAGE}\n`);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("without docker the judge refuses unless sandbox none", async () => {
    const empty = await mkdtemp(join(tmpdir(), "judge-no-docker-"));
    const marker = join(j.dir, "ran");
    const verdict = join(j.dir, "verdict.json");
    const saved = process.env["PATH"];
    process.env["PATH"] = empty;
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    try {
      await writeFile(verdict, "stale");
      const refused = await cli(boxed(j, `: > "${marker}"`, "--verdict", verdict, "--yes"), keys);
      expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
      expect(refused.err).toContain("docker is not available");
      expect(refused.err).toContain("install Docker from https://docs.docker.com/engine/install/");
      expect(refused.err).toContain("or pass --sandbox none");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(verdict)).toBe(false);
      expect(status(j.intent)).toBe(IntentStatus.Open);
      expect(warned.join("")).not.toContain(NO_SANDBOX);
      const unboxed = await cli(judging(j, `: > "${marker}"`, "--verdict", verdict), keys);
      expect([unboxed.code, unboxed.err]).toEqual([EXIT_OK, ""]);
      expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none", exitCode: 0 });
      expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(unboxed.json());
      expect(existsSync(marker)).toBe(true);
      expect(warned.join("")).toContain(NO_SANDBOX);
    } finally {
      process.env["PATH"] = saved;
      writes.mockRestore();
    }
  });

  it("the word count example passes inside the sandbox", DOCKER_TEST, async () => {
    const example = join(ROOT, "examples/jobs/word-count");
    const delivery = join(example, "delivery/wordcount.mjs");
    const counted = await job(await readFile(join(example, "SPEC.md"), "utf8"), await artifactSha256(delivery));
    const keysOf = { "judge.json": counted.judge };
    const checkArgs = ["--check", join(example, "check.mjs")];
    const preview = await cli(boxed({ ...counted, artifact: delivery }, "node check/check.mjs", ...checkArgs), keysOf);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ verdict: "pass", exitCode: 0, sandbox: "docker", image: SANDBOX_IMAGE, signature: null });
    const paid = await cli(boxed({ ...counted, artifact: delivery }, "node check/check.mjs", ...checkArgs, "--yes"), keysOf);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", sandbox: "docker", payTo: counted.worker.address, signature: expect.any(String) });
    expect(await paidTo(counted, counted.worker.address)).toBeGreaterThan(0n);

    const thief = await mkdtemp(join(tmpdir(), "judge-thief-"));
    const secret = join(tmpdir(), `judge-secret-${process.pid}.json`);
    await writeFile(secret, "[9,9,9]");
    await writeFile(
      join(thief, "wordcount.mjs"),
      `import { readFileSync } from "node:fs";\nlet stolen = "";\ntry {\n  stolen = readFileSync(${JSON.stringify(secret)}, "utf8");\n} catch {}\nexport default function count(text) {\n  return stolen === "" ? -1 : (text.match(/\\S+/g) ?? []).length;\n}\n`,
    );
    const stolen = await job(await readFile(join(example, "SPEC.md"), "utf8"), await artifactSha256(thief));
    const refused = await cli(boxed({ ...stolen, artifact: thief }, "node check/check.mjs", ...checkArgs, "--yes"), { "judge.json": stolen.judge });
    expect(refused.json()).toMatchObject({ verdict: "fail", exitCode: 1, sandbox: "docker", signature: null });
    expect(status(stolen.intent)).toBe(IntentStatus.Open);
    const unboxed = await cli(judging({ ...stolen, artifact: thief }, "node check/check.mjs", ...checkArgs), { "judge.json": stolen.judge });
    expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none" });
    await rm(secret, { force: true });
  });
});
