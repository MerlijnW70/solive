import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { ENV_KEYPAIR } from "../src/args.js";
import { CHECK_OUTPUT_LIMIT, outputCut } from "../src/check-output.js";
import { EXIT_RETRY, INFRA_NEXT, oomInfra } from "../src/judge-errors.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { containerArgs, NO_ISOLATION, NONE_NEEDS_TRUST, SANDBOX_IMAGE, SANDBOX_NOFILE, SANDBOX_PIDS, SANDBOX_USER, TRUST_ONLY_WITH_NONE } from "../src/sandbox.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { cli } from "./harness.js";
import { boxed, job, type Job, judging, status } from "./judge-kit.js";

const PLANTED_ENV = ["INTENT_ENGINE_KEYPAIR", "SOLANA_KEYPAIR", "JUDGE_SECRET", "AWS_SECRET_ACCESS_KEY"] as const;

type Planted = { canary: string; home: string; files: string[] };

async function plant(): Promise<Planted> {
  const canary = `canary-${randomBytes(12).toString("hex")}`;
  const home = await mkdtemp(join(tmpdir(), "judge-planted-home-"));
  const wallets = await mkdtemp(join(tmpdir(), "judge-planted-wallets-"));
  const files = [
    join(home, ".config", "solana", "id.json"),
    join(home, ".config", "intent-engine", "config.json"),
    join(home, "judge.json"),
    join(home, "encryption.json"),
    join(wallets, "multisig-keys.json"),
    join(wallets, "worker.json"),
  ];
  for (const file of files) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ secret: canary }));
  }
  return { canary, home, files };
}

async function withPlanted<T>(planted: Planted, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  const set = (key: string, value: string) => {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  };
  set("HOME", planted.home);
  set("USERPROFILE", planted.home);
  set(ENV_KEYPAIR, join(planted.home, "judge.json"));
  for (const key of PLANTED_ENV) {
    set(key, planted.canary);
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const notFound = (canary: string) =>
  [
    `! env | grep -qF "${canary}"`,
    `! grep -qsF "${canary}" /proc/1/environ`,
    `! grep -rqsF "${canary}" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev`,
  ].join(" && ");

describe("the judge keeps keys and the host out of the docker sandbox", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("no planted key file, wallet folder, home or secret variable reaches the container", DOCKER_TEST, async () => {
    const planted = await plant();
    const paths = planted.files.map((file) => `test ! -e "${file}"`).join(" && ");
    const run = await withPlanted(planted, () => cli(boxed(j, `${paths} && test ! -e "${planted.home}" && ${notFound(planted.canary)}`), keys));
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE });
    const probe = await withPlanted(planted, () => cli(boxed(j, `env | grep -qF "${planted.canary}"`), keys));
    expect(probe.json()).toMatchObject({ verdict: "fail", signature: null });
  });

  it("writes only to the in-memory /tmp, which is capped", DOCKER_TEST, async () => {
    const check = [
      ...["/", "/judge", "/judge/work", "/judge/spec", "/etc", "/usr", "/var", "/home", "/root", "/opt"].map((dir) => `! touch "${dir}/written" 2> /dev/null`),
      "echo ok > /tmp/written",
      'test "$(cat /tmp/written)" = ok',
      'test "$(findmnt -no FSTYPE /tmp 2> /dev/null || grep " /tmp " /proc/mounts | cut -d " " -f 3)" = tmpfs',
      "! dd if=/dev/zero of=/tmp/fill bs=1M count=80 2> /dev/null",
    ].join(" && ");
    const run = await cli(boxed(j, check, "--sandbox-tmp", "64m"), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker" });
  });

  it("runs with no capabilities, no new privileges, the default seccomp filter and its own namespaces", DOCKER_TEST, async () => {
    const check = [
      'test "$(id -u):$(id -g)" = 65534:65534',
      'test "$(grep ^CapEff /proc/self/status | cut -f 2)" = 0000000000000000',
      'test "$(grep ^CapPrm /proc/self/status | cut -f 2)" = 0000000000000000',
      'test "$(grep ^CapBnd /proc/self/status | cut -f 2)" = 0000000000000000',
      'test "$(grep ^NoNewPrivs /proc/self/status | cut -f 2)" = 1',
      'test "$(grep ^Seccomp: /proc/self/status | cut -f 2)" = 2',
      'test "$(cat /proc/self/cgroup)" = "0::/"',
      "test ! -e /var/run/docker.sock && test ! -e /run/docker.sock",
      'test "$(ls /sys/class/net)" = lo',
      'test "$(awk \'$5 ~ "^/judge" {print $5}\' /proc/self/mountinfo | sort | tr "\\n" " ")" = "/judge/spec /judge/work "',
      'test "$(ulimit -n)" = 1024',
      'test "$(ulimit -c)" = 0',
    ].join(" && ");
    const run = await cli(boxed(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker" });
  });

  it("a fork bomb meets the process limit", DOCKER_TEST, async () => {
    const probe = [
      'const { spawn } = require("node:child_process");',
      "const kids = []; let refused = 0;",
      `for (let i = 0; i < ${SANDBOX_PIDS + 100}; i++) { try { const kid = spawn("sleep", ["30"]); kid.on("error", () => { refused += 1; }); kids.push(kid); } catch { refused += 1; } }`,
      "setTimeout(() => {",
      "  const alive = kids.filter((kid) => kid.pid !== undefined && kid.exitCode === null).length;",
      '  for (const kid of kids) { try { kid.kill("SIGKILL"); } catch {} }',
      '  const counted = Number(require("node:fs").readFileSync("/sys/fs/cgroup/pids.events", "utf8").trim().split(" ")[1]);',
      `  process.exit(alive < ${SANDBOX_PIDS} && refused > 0 && counted > 0 ? 0 : 9);`,
      "}, 2000);",
    ].join(" ");
    const run = await cli(boxed(j, `node -e '${probe}'`), keys);
    expect([run.code, run.json()]).toEqual([EXIT_OK, expect.objectContaining({ verdict: "pass", sandbox: "docker" })]);
  });

  it("a memory bomb is stopped by the memory limit and reported as an infrastructure error, never a verdict", DOCKER_TEST, async () => {
    const verdict = join(j.dir, "verdict.json");
    const bomb = `node -e 'const kept = []; for (;;) kept.push(Buffer.alloc(16 << 20, 1))'`;
    const run = await cli(boxed(j, bomb, "--sandbox-memory", "256m", "--verdict", verdict, "--yes"), keys);
    expect([run.code, run.out, run.err]).toEqual([EXIT_RETRY, "", `infrastructure error, not a verdict: ${oomInfra("256m")}; ${INFRA_NEXT}`]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

});

describe("the docker arguments of a sandboxed check", () => {
  const copy = { root: "/host/copy", path: "/host/copy/work", spec: "/host/copy/spec/spec.md", check: undefined };
  const sandbox = { kind: "docker", image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false } as const;
  const argv = containerArgs(sandbox, copy, "a".repeat(64), "true");
  const pairs = (flag: string) => argv.flatMap((arg, at) => (arg === flag ? [argv[at + 1]] : []));

  it("carries every isolation flag, including those a check cannot observe from inside", () => {
    expect(pairs("--network")).toEqual(["none"]);
    expect(argv).toContain("--read-only");
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(pairs("--ipc")).toEqual(["private"]);
    expect(pairs("--cgroupns")).toEqual(["private"]);
    expect(pairs("--log-driver")).toEqual(["none"]);
    expect(pairs("--user")).toEqual([SANDBOX_USER]);
    expect(pairs("--pids-limit")).toEqual([String(SANDBOX_PIDS)]);
    expect([pairs("--memory"), pairs("--memory-swap"), pairs("--cpus")]).toEqual([["1g"], ["1g"], ["1"]]);
    expect(pairs("--ulimit")).toEqual([`nofile=${SANDBOX_NOFILE}:${SANDBOX_NOFILE}`, "core=0"]);
    expect(pairs("--tmpfs")).toEqual(["/tmp:rw,exec,nosuid,nodev,size=256m"]);
    expect(pairs("--mount")).toEqual([
      "type=bind,source=/host/copy/work,target=/judge/work,readonly",
      "type=bind,source=/host/copy/spec,target=/judge/spec,readonly",
    ]);
    expect(pairs("--env").map((env) => env?.split("=")[0])).toEqual(["HOME", "SPEC_PATH", "ARTIFACT_PATH", "ARTIFACT_SHA256"]);
  });

  it("never asks for a host namespace, extra privilege, the docker socket or a GPU unless --sandbox-gpu", () => {
    for (const flag of ["--privileged", "--pid", "--uts", "--userns", "--cap-add", "--device", "--volume", "-v", "--env-file", "--gpus", "--net", "--add-host", "--group-add"]) {
      expect(argv.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)), flag).toEqual([]);
    }
    for (const text of ["docker.sock", "unconfined", "host"]) {
      expect(argv.filter((arg) => arg.startsWith("type=bind") === false && arg.split(/[=:,]/).includes(text)), text).toEqual([]);
    }
    expect(containerArgs({ ...sandbox, gpu: true }, copy, "a".repeat(64), "true")).toEqual(expect.arrayContaining(["--gpus", "all"]));
  });
});

describe("--sandbox none", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("runs nothing without --i-trust-this-work, and records that no isolation was used", async () => {
    const marker = join(j.dir, "ran");
    const refused = await cli([...boxed(j, `touch "${marker}"`), "--sandbox", "none", "--yes"], keys);
    expect([refused.code, refused.err, refused.out]).toEqual([EXIT_USAGE, NONE_NEEDS_TRUST, ""]);
    expect(existsSync(marker)).toBe(false);
    const misplaced = await cli([...boxed(j, `touch "${marker}"`), "--i-trust-this-work"], keys);
    expect([misplaced.code, misplaced.err]).toEqual([EXIT_USAGE, TRUST_ONLY_WITH_NONE]);
    expect(existsSync(marker)).toBe(false);
    const trusted = await cli(judging(j, `touch "${marker}"`), keys);
    expect([trusted.code, trusted.err]).toEqual([EXIT_OK, ""]);
    expect(trusted.json()).toMatchObject({ verdict: "pass", sandbox: "none", warnings: [NO_ISOLATION] });
    expect(existsSync(marker)).toBe(true);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("passes no secret variable to the check, even without isolation", async () => {
    const planted = await plant();
    const run = await withPlanted(planted, () => cli(judging(j, PLANTED_ENV.map((key) => `test -z "$${key}"`).join(" && ")), keys));
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "none" });
  });

  it("shows the check's output with control characters escaped and cuts it at the limit", async () => {
    const shown: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => shown.push(String(text)) > 0);
    try {
      const noisy = `printf 'a\\033]0;owned\\007b\\r\\342\\200\\256c\\n'`;
      const run = await cli(judging(j, noisy), keys);
      expect(run.json()).toMatchObject({ verdict: "pass" });
      const text = shown.join("");
      expect(text).toContain("a\\u001b]0;owned\\u0007b\\u000d\\u202ec\n");
      expect(text).not.toMatch(/[\u001b\u0007\r‮]/u);
      shown.length = 0;
      const flood = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${CHECK_OUTPUT_LIMIT + 5000}))"`;
      const flooded = await cli(judging(j, flood), keys);
      expect(flooded.json()).toMatchObject({ verdict: "pass" });
      const out = shown.join("");
      expect(out).toContain(`${"x".repeat(CHECK_OUTPUT_LIMIT)}${outputCut(CHECK_OUTPUT_LIMIT)}`);
      expect(out).not.toContain("x".repeat(CHECK_OUTPUT_LIMIT + 1));
    } finally {
      writes.mockRestore();
    }
  });
});
