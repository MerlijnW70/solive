import { chmod, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOUNT_BASE, MOUNT_DIR } from "../src/artifact.js";
import { JudgeInfraError } from "../src/judge-errors.js";
import { type Doctor, DOCTOR_NOT_READY, MISSES_OOM, type Mounts, mountsNear, OOM_FLAGGED, OOM_UNFLAGGED, sandboxDoctor } from "../src/sandbox-doctor.js";
import { type Box, imageMissing, SANDBOX_IMAGE, sandboxReady } from "../src/sandbox.js";
import { exitedWith } from "../src/verdict-model.js";
import { type Call, FAST_LIMITS, type Plan, readCalls, scriptedDocker } from "./scripted-docker.js";

const BOX: Box = { image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false };

let dir = "";
let tmp = "";
const saved = { PATH: process.env["PATH"], TMPDIR: process.env["TMPDIR"], XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] };

const restore = (key: keyof typeof saved) => {
  const value = saved[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

async function faked(plan: Plan): Promise<{ path: string; calls: () => Promise<Call[]> }> {
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  await rm(bin, { recursive: true, force: true });
  await rm(log, { force: true });
  await mkdir(bin);
  await writeFile(join(bin, "docker"), scriptedDocker(log, tmp, plan));
  await chmod(join(bin, "docker"), 0o755);
  const calls = () => readCalls(log);
  return { path: bin, calls };
}

async function doctor(plan: Plan, keypair: string, measure?: () => Promise<Mounts | null>): Promise<{ found: Doctor; calls: Call[] }> {
  const fake = await faked(plan);
  process.env["PATH"] = fake.path;
  process.env["TMPDIR"] = tmp;
  process.env["XDG_RUNTIME_DIR"] = tmp;
  try {
    const found = await sandboxDoctor(BOX, keypair, measure, FAST_LIMITS);
    return { found, calls: await fake.calls() };
  } finally {
    restore("PATH");
    restore("TMPDIR");
    restore("XDG_RUNTIME_DIR");
  }
}

const checkNamed = (found: Doctor, name: string) => found.checks.find(({ check }) => check === name);

const scriptOf = (calls: Call[], match: string): string => calls.find(({ args }) => args[0] === "run" && args.join(" ").includes(match))?.args.join(" ") ?? "";

describe.skipIf(process.platform !== "linux")("sandbox doctor against a scripted docker", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kill-doctor-"));
    tmp = await mkdtemp(join(tmpdir(), "kill-doctor-tmp-"));
  });

  afterEach(async () => {
    restore("PATH");
    restore("TMPDIR");
    restore("XDG_RUNTIME_DIR");
    await rm(dir, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes a probe only on exit 0 with its container gone, and judges the memory and time probes by their own outcome", async () => {
    const { found, calls } = await doctor(
      {
        imageEnv: { code: 0, out: '["PATH=/usr/bin","IMAGE_OWN=1"]' },
        runs: [
          { match: "ls /sys/class/net", code: 1 },
          { match: "/dev/zero", code: 137, oom: true },
        ],
      },
      join(dir, "judge.json"),
    );
    expect(found.checks[0]).toStrictEqual({ check: "docker is usable", ok: true, detail: "27.0.0" });
    expect(found.checks[1]).toStrictEqual({ check: "image present and pinned by digest", ok: true });
    expect(checkNamed(found, "the image's own environment can be read")).toBeUndefined();
    expect(checkNamed(found, "no network: only the loopback interface")).toStrictEqual({ check: "no network: only the loopback interface", ok: false, detail: exitedWith(1) });
    expect(checkNamed(found, "read-only root filesystem")).toStrictEqual({ check: "read-only root filesystem", ok: true });
    expect(checkNamed(found, "a memory bomb is killed at the memory limit and reported as out of memory")?.ok).toBe(true);
    expect(checkNamed(found, "a check past its time limit is stopped and its container removed")?.ok).toBe(false);
    expect(found.keypair).toStrictEqual({ path: join(dir, "judge.json"), reachable: false });
    expect([found.ready, found.next]).toStrictEqual([false, DOCTOR_NOT_READY]);
    expect(scriptOf(calls, "while [ $n -lt")).toContain("while [ $n -lt 400 ]");
    expect(scriptOf(calls, "memory.max")).toContain("= 1073741824");
    expect(scriptOf(calls, "cpu.max")).toContain("= 100000");
    expect(scriptOf(calls, "allowed=")).toContain(" IMAGE_OWN ");
    const sources = calls.filter(({ args }) => args[0] === "run").flatMap(({ args }) => args.filter((arg) => arg.startsWith("type=bind,")).map((arg) => arg.split(",")[1]));
    const owner = MOUNT_BASE;
    const slot = join(tmp, MOUNT_DIR, `${owner}NS`, "slot-0");
    expect([...new Set(sources)].map((source) => source?.replace(new RegExp(`${owner}\\d+/`), `${owner}NS/`))).toEqual([`source=${join(slot, "work")}`, `source=${join(slot, "spec")}`]);
  });

  it("passes a memory bomb Docker did not flag but that ended with 137 and was judged infra, and warns that Docker misses the flag", async () => {
    const keypair = join(dir, "judge.json");
    const unflagged = await doctor({ runs: [{ match: "/dev/zero", code: 137 }] }, keypair, async () => null);
    expect(checkNamed(unflagged.found, "a memory bomb is killed at the memory limit and reported as out of memory")).toStrictEqual({
      check: "a memory bomb is killed at the memory limit and reported as out of memory",
      ok: true,
      detail: OOM_UNFLAGGED,
    });
    expect(unflagged.found.warnings).toStrictEqual([MISSES_OOM]);
    const flagged = await doctor({ runs: [{ match: "/dev/zero", code: 137, oom: true }] }, keypair, async () => null);
    expect(checkNamed(flagged.found, "a memory bomb is killed at the memory limit and reported as out of memory")).toStrictEqual({
      check: "a memory bomb is killed at the memory limit and reported as out of memory",
      ok: true,
      detail: OOM_FLAGGED,
    });
    expect(flagged.found.warnings).toStrictEqual([]);
    const full = { count: 99_968, limit: 100_000 };
    const both = await doctor({ runs: [{ match: "/dev/zero", code: 137 }] }, keypair, async () => full);
    expect(both.found.warnings).toStrictEqual([mountsNear(full), MISSES_OOM]);
  });

  it("warns when the host's mounts are near the limit, and the warning alone changes no check", async () => {
    const plan = { runs: [{ match: "/dev/zero", code: 137, oom: true }] };
    const keypair = join(dir, "judge.json");
    const full = { count: 99_968, limit: 100_000 };
    const near = await doctor(plan, keypair, async () => full);
    expect([near.found.mounts, near.found.warnings]).toStrictEqual([full, [mountsNear(full)]]);
    expect(near.found.warnings[0]).toContain("no space left on device");
    const far = await doctor(plan, keypair, async () => ({ count: 1_000, limit: 100_000 }));
    expect(far.found.warnings).toStrictEqual([]);
    expect([near.found.checks, near.found.ready]).toStrictEqual([far.found.checks, far.found.ready]);
    const unknown = await doctor(plan, keypair, async () => null);
    expect([unknown.found.mounts, unknown.found.warnings]).toStrictEqual([null, []]);
  });

  it("fails the memory probe that was not killed, and names an image environment it cannot read", async () => {
    const { found, calls } = await doctor({ imageEnv: { code: 1 } }, join(dir, "judge.json"));
    expect(checkNamed(found, "the image's own environment can be read")).toStrictEqual({ check: "the image's own environment can be read", ok: false });
    expect(checkNamed(found, "a memory bomb is killed at the memory limit and reported as out of memory")?.ok).toBe(false);
    const exited = await doctor({ runs: [{ match: "/dev/zero", code: 1 }] }, join(dir, "judge.json"));
    expect(checkNamed(exited.found, "a memory bomb is killed at the memory limit and reported as out of memory")?.ok).toBe(false);
    expect(exited.found.warnings).toStrictEqual([]);
    expect(checkNamed(found, "read-only root filesystem")?.ok).toBe(true);
    expect(scriptOf(calls, "allowed=")).not.toContain(" IMAGE_OWN ");
    expect(found.ready).toBe(false);
  });

  it("still answers when the planted canary and the probe artifact are already gone", async () => {
    const { found } = await doctor({ unlink: true }, join(dir, "judge.json"));
    expect(found.checks[0]?.ok).toBe(true);
    expect(found.ready).toBe(false);
  });

  it("stops at an image docker can neither find nor pull, with the keypair counted as reachable", async () => {
    const full = { count: 90_000, limit: 100_000 };
    const { found } = await doctor({ imageId: { code: 1 }, pull: { code: 1, out: "pull denied" } }, join(dir, "judge.json"), async () => full);
    expect(found).toStrictEqual({
      docker: "27.0.0",
      image: SANDBOX_IMAGE,
      gpu: false,
      keypair: { path: join(dir, "judge.json"), reachable: true },
      memory_pin: null,
      mounts: full,
      warnings: [mountsNear(full)],
      checks: [
        { check: "docker is usable", ok: true, detail: "27.0.0" },
        { check: "image present and pinned by digest", ok: false, detail: new JudgeInfraError(imageMissing(SANDBOX_IMAGE, "")).message.slice(0, 300) },
      ],
      ready: false,
      next: DOCTOR_NOT_READY,
    });
  });

  it("counts the keypair as reachable when docker itself is not usable", async () => {
    const { found } = await doctor({ version: { code: 1, out: "cannot connect" } }, join(dir, "judge.json"), async () => null);
    expect(found).toStrictEqual({
      docker: null,
      image: SANDBOX_IMAGE,
      gpu: false,
      keypair: { path: join(dir, "judge.json"), reachable: true },
      memory_pin: null,
      mounts: null,
      warnings: [],
      checks: [{ check: "docker is usable", ok: false, detail: "cannot connect" }],
      ready: false,
      next: DOCTOR_NOT_READY,
    });
  });

  it("reads the image lookup quietly and shows the pull on the judge's stderr", async () => {
    const own = await readlink("/proc/self/fd/2");
    const fake = await faked({ imageId: { code: 1 }, pull: { code: 0 } });
    await sandboxReady({ kind: "docker", ...BOX }, { PATH: fake.path });
    const calls = await fake.calls();
    expect(calls.map(({ args }) => args[0])).toStrictEqual(["version", "image", "pull"]);
    expect(calls.map(({ stdout }) => stdout === own)).toStrictEqual([false, false, true]);
  });
});
