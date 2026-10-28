import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerLeft, docker, removeContainer, runContainer } from "../src/check-process.js";
import { dockerTimedOut, startFailed } from "../src/container-check.js";
import { JudgeInfraError } from "../src/judge-errors.js";
import { dockerMissing, imageMissing, SANDBOX_IMAGE, sandboxReady } from "../src/sandbox.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls"
case "$1" in
  version)
    if [ "$FAKE_VERSION" = fail ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    echo "fake docker 1.0"; exit 0 ;;
  image) exit "\${FAKE_IMAGE:-1}" ;;
  pull)
    case "$FAKE_PULL" in
      fail) echo "manifest unknown" >&2; exit 1 ;;
      hang) sleep 10; exit 0 ;;
    esac
    exit 0 ;;
  rm) exit 0 ;;
  container)
    if [ "$3" = "--format" ]; then
      if [ -n "$FAKE_STATE" ]; then echo "$FAKE_STATE"; else echo '{"OOMKilled":false,"Error":""}'; fi
      exit 0
    fi
    exit "\${FAKE_INSPECT:-1}" ;;
  kill)
    if [ "$FAKE_KILL" = stops ]; then kill -USR1 "$(cat "$FAKE_DIR/$2.pid")"; fi
    exit 0 ;;
  run)
    echo $$ > "$FAKE_DIR/$3.pid"
    case "$FAKE_RUN" in
      exit) exit 3 ;;
      start) echo "docker: Error response from daemon: no such image" >&2; exit 125 ;;
      oom) exit 137 ;;
      noisy) printf 'line\\033[2J\\r\\342\\200\\256end\\n'; exit 0 ;;
      slow) sleep 0.3; exit 0 ;;
      hang)
        trap 'exit 137' USR1
        n=0
        while [ $n -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
        exit 0 ;;
    esac ;;
esac
exit 9
`;

let dir = "";

const envFor = (fake: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: `${dir}:${process.env["PATH"] ?? ""}`, FAKE_DIR: dir, ...fake });

const calls = async (): Promise<string[]> => (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");

const spawned = () => vi.mocked(spawn).mock.calls.map(([file, args, options]) => ({ file, args, options }));

describe.skipIf(process.platform === "win32")("the docker client the sandbox drives", () => {
  let warned: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "container-check-"));
    await writeFile(join(dir, "docker"), FAKE_DOCKER);
    await chmod(join(dir, "docker"), 0o755);
    vi.mocked(spawn).mockClear();
    warned = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("captures what docker prints unless asked to show it, and hides its window", async () => {
    expect(await docker(["version"], envFor({}))).toStrictEqual({ status: 0, out: "fake docker 1.0" });
    expect(spawned()).toEqual([{ file: "docker", args: ["version"], options: expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) }]);
  });

  it("warns only when the container is still there after it was removed", async () => {
    await removeContainer("left-1", envFor({ FAKE_INSPECT: "0" }));
    expect(warned).toEqual([`${containerLeft("left-1")}\n`]);
    warned.length = 0;
    await removeContainer("gone-1", envFor({ FAKE_INSPECT: "1" }));
    expect(warned).toEqual([]);
    expect(await calls()).toEqual(["rm -f -v left-1", "container inspect left-1", "rm -f -v gone-1", "container inspect gone-1"]);
  });

  it("reports the exit code of a container that ends by itself, then removes it", async () => {
    expect(await runContainer(["image"], "ends-1", envFor({ FAKE_RUN: "exit" }), 30)).toStrictEqual({ exitCode: 3, timedOut: false });
    expect(spawned()[0]).toEqual({
      file: "docker",
      args: ["run", "--name", "ends-1", "image"],
      options: expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }),
    });
    expect(await calls()).toEqual(["run --name ends-1 image", "container inspect --format {{json .State}} ends-1", "rm -f -v ends-1", "container inspect ends-1"]);
    expect(warned).toEqual([]);
  });

  it("counts --timeout in seconds, so a container that ends within it is not stopped", async () => {
    expect(await runContainer(["image"], "slow-1", envFor({ FAKE_RUN: "slow" }), 5)).toStrictEqual({ exitCode: 0, timedOut: false });
    expect(await calls()).toEqual(["run --name slow-1 image", "container inspect --format {{json .State}} slow-1", "rm -f -v slow-1", "container inspect slow-1"]);
  });

  it("stops a container at the timeout and reports no exit code, even when docker kill ends it with one", async () => {
    expect(await runContainer(["image"], "late-1", envFor({ FAKE_RUN: "hang", FAKE_KILL: "stops" }), 0.2)).toStrictEqual({ exitCode: null, timedOut: true });
    expect(await calls()).toEqual(["run --name late-1 image", "kill late-1", "rm -f -v late-1", "rm -f -v late-1", "container inspect late-1"]);
  });

  it("kills the docker client itself when docker kill does not end it", async () => {
    const started = Date.now();
    expect(await runContainer(["image"], "stuck-1", envFor({ FAKE_RUN: "hang" }), 0.2)).toStrictEqual({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await calls()).toEqual(["run --name stuck-1 image", "kill stuck-1", "rm -f -v stuck-1", "rm -f -v stuck-1", "container inspect stuck-1"]);
  }, 30_000);

  it("reports a container docker could not start as an infrastructure error, not an exit code to judge", async () => {
    expect(await runContainer(["image"], "start-1", envFor({ FAKE_RUN: "start" }), 30)).toStrictEqual({ exitCode: 125, timedOut: false, infra: startFailed(125, "") });
    const failing = '{"OOMKilled":false,"Error":"OCI runtime create failed"}';
    expect(await runContainer(["image"], "start-2", envFor({ FAKE_RUN: "exit", FAKE_STATE: failing }), 30)).toStrictEqual({
      exitCode: 3,
      timedOut: false,
      infra: startFailed(3, "OCI runtime create failed"),
    });
  });

  it("treats docker being down, a failed pull and a pull that hangs as infrastructure errors, each within its time limit", async () => {
    const box = { kind: "docker", image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false } as const;
    const limits = { ask: 2, pull: 0.3 };
    await expect(sandboxReady(box, envFor({ FAKE_VERSION: "fail" }), limits)).rejects.toThrow(new JudgeInfraError(dockerMissing("Cannot connect to the Docker daemon")));
    await expect(sandboxReady(box, envFor({ FAKE_IMAGE: "0" }), limits)).resolves.toBeUndefined();
    await expect(sandboxReady(box, envFor({ FAKE_PULL: "fail" }), limits)).rejects.toBeInstanceOf(JudgeInfraError);
    const started = Date.now();
    await expect(sandboxReady(box, envFor({ FAKE_PULL: "hang" }), limits)).rejects.toThrow(new JudgeInfraError(imageMissing(SANDBOX_IMAGE, dockerTimedOut(0.3))));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a container the kernel killed for memory as out of memory", async () => {
    const killed = '{"OOMKilled":true,"Error":""}';
    expect(await runContainer(["image"], "oom-1", envFor({ FAKE_RUN: "oom", FAKE_STATE: killed }), 30)).toStrictEqual({ exitCode: 137, timedOut: false, oom: true });
    expect(await calls()).toEqual(["run --name oom-1 image", "container inspect --format {{json .State}} oom-1", "rm -f -v oom-1", "container inspect oom-1"]);
  });

  it("counts a kill with signal 9 as out of memory even when docker has not flagged it yet", async () => {
    expect(await runContainer(["image"], "oom-2", envFor({ FAKE_RUN: "oom" }), 30)).toStrictEqual({ exitCode: 137, timedOut: false, oom: true });
  });

  it("counts docker's out-of-memory flag even when the container's shell survives and exits otherwise", async () => {
    const killed = '{"OOMKilled":true,"Error":""}';
    expect(await runContainer(["image"], "oom-3", envFor({ FAKE_RUN: "exit", FAKE_STATE: killed }), 30)).toStrictEqual({ exitCode: 3, timedOut: false, oom: true });
  });

  it("shows what the container prints only with its control characters escaped", async () => {
    expect(await runContainer(["image"], "noisy-1", envFor({ FAKE_RUN: "noisy" }), 30)).toStrictEqual({ exitCode: 0, timedOut: false });
    const shown = warned.join("");
    expect(shown).toContain("line\\u001b[2J\\u000d\\u202eend\n");
    expect(shown).not.toMatch(/[\u001b\r‮]/u);
  });
});
