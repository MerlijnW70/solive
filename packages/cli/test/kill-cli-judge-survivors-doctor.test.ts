import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JudgeInfraError } from "../src/judge-errors.js";
import { type Doctor, DOCTOR_NOT_READY, sandboxDoctor } from "../src/sandbox-doctor.js";
import { type Box, imageMissing, SANDBOX_IMAGE, sandboxReady } from "../src/sandbox.js";

type Answer = { code: number; out?: string };

type Plan = {
  version?: Answer;
  imageId?: Answer;
  imageEnv?: Answer;
  pull?: Answer;
  runs?: { match: string; code: number }[];
  unlink?: boolean;
};

type Call = { args: string[]; stdout: string };

const FAKE = (log: string, tmp: string, plan: Plan) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const plan = ${JSON.stringify(plan)};
const args = process.argv.slice(2);
let stdout = "";
try { stdout = fs.readlinkSync("/proc/self/fd/1"); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdout }) + "\\n");
const answer = (found) => { process.stdout.write(found.out ?? ""); process.exitCode = found.code; };
const joined = args.join(" ");
if (args[0] === "version") answer(plan.version ?? { code: 0, out: "27.0.0" });
else if (args[0] === "image" && joined.includes("{{.Id}}")) answer(plan.imageId ?? { code: 0, out: "sha256:feed" });
else if (args[0] === "image") answer(plan.imageEnv ?? { code: 0, out: "null" });
else if (args[0] === "pull") answer(plan.pull ?? { code: 1 });
else if (args[0] === "run") {
  if (plan.unlink) {
    for (const name of fs.readdirSync(${JSON.stringify(tmp)})) {
      if (/^sandbox-doctor-(canary-[0-9a-f]+\\.json|[0-9a-f]{12}\\.txt)$/.test(name)) fs.rmSync(path.join(${JSON.stringify(tmp)}, name), { force: true });
    }
  }
  const run = (plan.runs ?? []).find(({ match }) => joined.includes(match));
  answer({ code: run === undefined ? 0 : run.code });
}
else if (args[0] === "container") answer({ code: 1 });
else answer({ code: 0 });
`;

const BOX: Box = { image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false };

let dir = "";
let tmp = "";
const saved = { PATH: process.env["PATH"], TMPDIR: process.env["TMPDIR"] };

const restore = (key: "PATH" | "TMPDIR") => {
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
  await writeFile(join(bin, "docker"), FAKE(log, tmp, plan));
  await chmod(join(bin, "docker"), 0o755);
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter((entry) => entry !== "")
      .map((entry) => JSON.parse(entry) as Call);
  return { path: bin, calls };
}

async function doctor(plan: Plan, keypair: string): Promise<{ found: Doctor; calls: Call[] }> {
  const fake = await faked(plan);
  process.env["PATH"] = fake.path;
  process.env["TMPDIR"] = tmp;
  try {
    const found = await sandboxDoctor(BOX, keypair);
    return { found, calls: await fake.calls() };
  } finally {
    restore("PATH");
    restore("TMPDIR");
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
    await rm(dir, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes a probe only on exit 0 with its container gone, and judges the memory and time probes by their own outcome", async () => {
    const { found, calls } = await doctor(
      {
        imageEnv: { code: 0, out: '["PATH=/usr/bin","IMAGE_OWN=1"]' },
        runs: [
          { match: "ls /sys/class/net", code: 1 },
          { match: "/dev/zero", code: 137 },
        ],
      },
      join(dir, "judge.json"),
    );
    expect(found.checks[0]).toStrictEqual({ check: "docker is usable", ok: true, detail: "27.0.0" });
    expect(found.checks[1]).toStrictEqual({ check: "image present and pinned by digest", ok: true });
    expect(checkNamed(found, "the image's own environment can be read")).toBeUndefined();
    expect(checkNamed(found, "no network: only the loopback interface")).toStrictEqual({ check: "no network: only the loopback interface", ok: false, detail: "exit 1" });
    expect(checkNamed(found, "read-only root filesystem")).toStrictEqual({ check: "read-only root filesystem", ok: true });
    expect(checkNamed(found, "a memory bomb is killed at the memory limit and reported as out of memory")?.ok).toBe(true);
    expect(checkNamed(found, "a check past its time limit is stopped and its container removed")?.ok).toBe(false);
    expect(found.keypair).toStrictEqual({ path: join(dir, "judge.json"), reachable: false });
    expect([found.ready, found.next]).toStrictEqual([false, DOCTOR_NOT_READY]);
    expect(scriptOf(calls, "while [ $n -lt")).toContain("while [ $n -lt 400 ]");
    expect(scriptOf(calls, "memory.max")).toContain("= 1073741824");
    expect(scriptOf(calls, "cpu.max")).toContain("= 100000");
    expect(scriptOf(calls, "allowed=")).toContain(" IMAGE_OWN ");
  });

  it("fails the memory probe that was not killed, and names an image environment it cannot read", async () => {
    const { found, calls } = await doctor({ imageEnv: { code: 1 } }, join(dir, "judge.json"));
    expect(checkNamed(found, "the image's own environment can be read")).toStrictEqual({ check: "the image's own environment can be read", ok: false });
    expect(checkNamed(found, "a memory bomb is killed at the memory limit and reported as out of memory")?.ok).toBe(false);
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
    const { found } = await doctor({ imageId: { code: 1 }, pull: { code: 1, out: "pull denied" } }, join(dir, "judge.json"));
    expect(found).toStrictEqual({
      docker: "27.0.0",
      image: SANDBOX_IMAGE,
      gpu: false,
      keypair: { path: join(dir, "judge.json"), reachable: true },
      checks: [
        { check: "docker is usable", ok: true, detail: "27.0.0" },
        { check: "image present and pinned by digest", ok: false, detail: new JudgeInfraError(imageMissing(SANDBOX_IMAGE, "")).message.slice(0, 300) },
      ],
      ready: false,
      next: DOCTOR_NOT_READY,
    });
  });

  it("counts the keypair as reachable when docker itself is not usable", async () => {
    const { found } = await doctor({ version: { code: 1, out: "cannot connect" } }, join(dir, "judge.json"));
    expect(found).toStrictEqual({
      docker: null,
      image: SANDBOX_IMAGE,
      gpu: false,
      keypair: { path: join(dir, "judge.json"), reachable: true },
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
