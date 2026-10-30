import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { DOCTOR_NOT_READY, DOCTOR_READY, quiet } from "../src/sandbox-doctor.js";
import { IMAGE_NEEDS_DIGEST, SANDBOX_IMAGE, SANDBOX_NEEDS_DOCTOR } from "../src/sandbox.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { cli } from "./harness.js";

const CHECKS = [
  "docker is usable",
  "image present and pinned by digest",
  "no network: only the loopback interface",
  "read-only root filesystem",
  "artifact and spec mounted read-only",
  "only the in-memory /tmp is writable",
  "runs as a user other than root",
  "no capabilities",
  "no new privileges",
  "seccomp filter on",
  "no docker socket",
  "no host paths beyond the artifact and spec",
  "process limit of 256",
  "memory limit of 1g",
  "cpu limit of 1",
  "a fork bomb meets the process limit",
  "no host file, home, wallet or judge keypair is visible",
  "no host environment variable is passed in",
  "a memory bomb is killed at the memory limit and reported as out of memory",
  "a check past its time limit is stopped and its container removed",
];

describe("intent-engine sandbox doctor", () => {
  it("runs every isolation check live and finds the judge keypair out of reach", { ...DOCKER_TEST, timeout: 600_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-keys-"));
    const keypair = join(dir, "judge.json");
    await writeFile(keypair, "[1,2,3]");
    const run = await cli(["sandbox", "doctor", "--keypair", keypair], {});
    const doctor = run.json();
    expect((doctor["checks"] as { check: string; ok: boolean; detail?: string }[]).filter((check) => !check.ok)).toEqual([]);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(doctor).toMatchObject({ image: SANDBOX_IMAGE, gpu: false, keypair: { path: keypair, reachable: false }, ready: true, next: DOCTOR_READY });
    expect((doctor["checks"] as { check: string; ok: boolean }[]).map((check) => [check.check, check.ok])).toEqual(CHECKS.map((check) => [check, true]));
  });

  it("is not ready, and exits 1, when docker is not usable", async () => {
    const empty = await mkdtemp(join(tmpdir(), "doctor-no-docker-"));
    const saved = process.env["PATH"];
    process.env["PATH"] = empty;
    try {
      const run = await cli(["sandbox", "doctor"], {});
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.json()).toMatchObject({ docker: null, ready: false, next: DOCTOR_NOT_READY, checks: [{ check: "docker is usable", ok: false }] });
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("takes only doctor, and refuses an image without a digest", async () => {
    expect(await cli(["sandbox"], {})).toMatchObject({ code: EXIT_USAGE, err: SANDBOX_NEEDS_DOCTOR });
    expect(await cli(["sandbox", "check"], {})).toMatchObject({ code: EXIT_USAGE, err: SANDBOX_NEEDS_DOCTOR });
    expect(await cli(["sandbox", "doctor", "--sandbox-image", "node:22"], {})).toMatchObject({ code: EXIT_USAGE, err: IMAGE_NEEDS_DIGEST });
  });
});

describe("sandbox doctor probe scripts", () => {
  it("keeps the shell job-control line about a killed process out of the output", () => {
    const quieted = spawnSync("sh", ["-c", quiet("sh -c 'kill -9 $$' | cat")], { encoding: "utf8" });
    expect([quieted.stdout, quieted.stderr]).toEqual(["", ""]);
  });

  it("keeps the exit status of the probe it wraps", () => {
    expect(spawnSync("sh", ["-c", quiet("exit 7")]).status).toBe(7);
    expect(quiet("true")).toBe("( true ) 2> /dev/null");
  });
});
