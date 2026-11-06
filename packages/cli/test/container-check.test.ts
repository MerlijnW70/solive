import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerLeft, docker, removeContainer, runContainer } from "../src/check-process.js";
import { dockerTimedOut, startFailed } from "../src/container-check.js";
import { JudgeInfraError, oomInfra, timedOutInfra } from "../src/judge-errors.js";
import { dockerMissing, imageMissing, SANDBOX_IMAGE, sandboxReady } from "../src/sandbox.js";
import { containerOutcome, exitedWith, inspectFailed, killedUnflagged, NEVER_STARTED, oomPinned, ranPastPin, RUN_UNTIMED } from "../src/verdict-model.js";

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
    if [ "$4" = "{{.State.Status}}" ]; then echo "\${FAKE_STATUS:-exited}"; exit 0; fi
    if [ "$3" = "--format" ]; then
      if [ "$FAKE_INSPECT_FAIL" = 1 ]; then echo "Error: No such container: $5" >&2; exit 1; fi
      if [ "$FAKE_INSPECT_HANG" = 1 ]; then sleep 10; fi
      code=$(cat "$FAKE_DIR/$5.code" 2>/dev/null || echo 0)
      if [ -n "$FAKE_STATE" ]; then echo "$FAKE_STATE"; else echo "{\\"Running\\":false,\\"ExitCode\\":$code,\\"OOMKilled\\":false,\\"Error\\":\\"\\",\\"StartedAt\\":\\"2026-01-01T00:00:00Z\\"}"; fi
      exit 0
    fi
    exit "\${FAKE_INSPECT:-1}" ;;
  kill)
    if [ "$FAKE_KILL" = stops ]; then kill -USR1 "$(cat "$FAKE_DIR/$2.pid")"; fi
    exit 0 ;;
  run)
    echo $$ > "$FAKE_DIR/$3.pid"
    case "$FAKE_RUN" in
      exit) echo 3 > "$FAKE_DIR/$3.code"; exit 3 ;;
      own125) echo "docker: Error response from daemon: forged by the check" >&2; echo 125 > "$FAKE_DIR/$3.code"; exit 125 ;;
      start) echo "docker: Error response from daemon: no such image" >&2; exit 125 ;;
      oom) echo 137 > "$FAKE_DIR/$3.code"; exit 137 ;;
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

const ended = (exitCode: number, more: Partial<{ started: boolean; oomKilled: boolean; error: string }> = {}) => ({ started: true, exitCode, oomKilled: false, error: "", ...more });

const limits = { seconds: 30, memory: "1g" };

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

  it("reports the container's own exit code, read with inspect before it is removed", async () => {
    const ran = await runContainer(["image"], "ends-1", envFor({ FAKE_RUN: "exit" }), 30);
    expect(ran).toStrictEqual({ exitCode: 3, timedOut: false, deadline: false, state: ended(3) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "fail", reason: exitedWith(3) });
    expect(spawned()[0]).toEqual({
      file: "docker",
      args: ["run", "--name", "ends-1", "image"],
      options: expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }),
    });
    expect(await calls()).toEqual(["run --name ends-1 image", "container inspect --format {{json .State}} ends-1", "rm -f -v ends-1", "container inspect ends-1"]);
    expect(warned).toEqual([]);
  });

  it("counts --timeout in seconds, so a container that ends within it is not stopped", async () => {
    const ran = await runContainer(["image"], "slow-1", envFor({ FAKE_RUN: "slow" }), 5);
    expect(ran).toStrictEqual({ exitCode: 0, timedOut: false, deadline: false, state: ended(0) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "pass" });
    expect(await calls()).toEqual(["run --name slow-1 image", "container inspect --format {{json .State}} slow-1", "rm -f -v slow-1", "container inspect slow-1"]);
  });

  it("stops a container at the timeout and reports no exit code, even when docker kill ends it with one", async () => {
    const ran = await runContainer(["image"], "late-1", envFor({ FAKE_RUN: "hang", FAKE_KILL: "stops" }), 0.2);
    expect(ran).toStrictEqual({ exitCode: null, timedOut: true, deadline: true, state: null });
    expect(containerOutcome(ran, { ...limits, seconds: 0.2 })).toEqual({ outcome: "infra", reason: timedOutInfra(0.2) });
    expect(await calls()).toEqual(["run --name late-1 image", "kill late-1", "rm -f -v late-1", "rm -f -v late-1", "container inspect late-1"]);
  });

  it("kills the docker client itself when docker kill does not end it", async () => {
    const started = Date.now();
    expect(await runContainer(["image"], "stuck-1", envFor({ FAKE_RUN: "hang" }), 0.2)).toStrictEqual({ exitCode: null, timedOut: true, deadline: true, state: null });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await calls()).toEqual(["run --name stuck-1 image", "kill stuck-1", "rm -f -v stuck-1", "rm -f -v stuck-1", "container inspect stuck-1"]);
  }, 30_000);

  it("reports a container docker could not create or start as an infrastructure error, not an exit code to judge", async () => {
    const missing = await runContainer(["image"], "start-1", envFor({ FAKE_RUN: "start", FAKE_INSPECT_FAIL: "1" }), 30);
    expect(missing).toStrictEqual({ exitCode: null, timedOut: false, deadline: false, state: null, inspect: "Error: No such container: start-1" });
    expect(containerOutcome(missing, limits)).toEqual({ outcome: "infra", reason: inspectFailed("Error: No such container: start-1") });
    const failing = '{"Running":false,"ExitCode":127,"OOMKilled":false,"Error":"OCI runtime create failed","StartedAt":"0001-01-01T00:00:00Z"}';
    const refused = await runContainer(["image"], "start-2", envFor({ FAKE_RUN: "exit", FAKE_STATE: failing }), 30);
    expect(refused).toStrictEqual({ exitCode: 127, timedOut: false, deadline: false, state: ended(127, { started: false, error: "OCI runtime create failed" }) });
    expect(containerOutcome(refused, limits)).toEqual({ outcome: "infra", reason: startFailed(127, "OCI runtime create failed") });
    const idle = '{"Running":false,"ExitCode":0,"OOMKilled":false,"Error":"","StartedAt":"0001-01-01T00:00:00Z"}';
    const never = await runContainer(["image"], "start-3", envFor({ FAKE_RUN: "slow", FAKE_STATE: idle }), 30);
    expect(containerOutcome(never, limits)).toEqual({ outcome: "infra", reason: NEVER_STARTED });
  });

  it("judges exit 125 from inside a started container as the check's own fail, whatever it prints", async () => {
    const ran = await runContainer(["image"], "own-1", envFor({ FAKE_RUN: "own125" }), 30);
    expect(ran).toStrictEqual({ exitCode: 125, timedOut: false, deadline: false, state: ended(125) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "fail", reason: exitedWith(125) });
  });

  it("treats an inspect that fails, hangs, answers unreadably or finds the container still running as an infrastructure error", async () => {
    const started = Date.now();
    const hung = await runContainer(["image"], "hang-1", envFor({ FAKE_RUN: "exit", FAKE_INSPECT_HANG: "1" }), 30, 0.3);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hung).toStrictEqual({ exitCode: null, timedOut: false, deadline: false, state: null, inspect: dockerTimedOut(0.3) });
    expect(containerOutcome(hung, limits)).toEqual({ outcome: "infra", reason: inspectFailed(dockerTimedOut(0.3)) });
    for (const state of ["not json", "[1]", '{"Running":true,"ExitCode":0,"OOMKilled":false,"Error":"","StartedAt":"2026-01-01T00:00:00Z"}', '{"Running":false,"OOMKilled":false,"Error":""}']) {
      const ran = await runContainer(["image"], "odd-1", envFor({ FAKE_RUN: "slow", FAKE_STATE: state }), 30);
      expect(ran.state, state).toBeNull();
      expect(containerOutcome(ran, limits).outcome, state).toBe("infra");
    }
  });

  it("treats docker being down, a failed pull and a pull that hangs as infrastructure errors, each within its time limit", async () => {
    const box = { kind: "docker", image: SANDBOX_IMAGE, memory: "1g", cpus: "1", tmp: "256m", gpu: false } as const;
    const limitsOf = { ask: 2, pull: 0.3 };
    await expect(sandboxReady(box, envFor({ FAKE_VERSION: "fail" }), limitsOf)).rejects.toThrow(new JudgeInfraError(dockerMissing("Cannot connect to the Docker daemon")));
    await expect(sandboxReady(box, envFor({ FAKE_IMAGE: "0" }), limitsOf)).resolves.toBeUndefined();
    await expect(sandboxReady(box, envFor({ FAKE_PULL: "fail" }), limitsOf)).rejects.toBeInstanceOf(JudgeInfraError);
    const started = Date.now();
    await expect(sandboxReady(box, envFor({ FAKE_PULL: "hang" }), limitsOf)).rejects.toThrow(new JudgeInfraError(imageMissing(SANDBOX_IMAGE, dockerTimedOut(0.3))));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a container the kernel killed for memory as out of memory", async () => {
    const killed = '{"Running":false,"ExitCode":137,"OOMKilled":true,"Error":"","StartedAt":"2026-01-01T00:00:00Z"}';
    const ran = await runContainer(["image"], "oom-1", envFor({ FAKE_RUN: "oom", FAKE_STATE: killed }), 30);
    expect(ran).toStrictEqual({ exitCode: 137, timedOut: false, deadline: false, state: ended(137, { oomKilled: true }) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "infra", reason: oomInfra("1g") });
    expect(await calls()).toEqual(["run --name oom-1 image", "container inspect --format {{json .State}} oom-1", "rm -f -v oom-1", "container inspect oom-1"]);
  });

  it("judges a kill with signal 9 that docker did not flag as out of memory infra under the judge's memory, and the check's own fail under pinned memory", async () => {
    const ran = await runContainer(["image"], "oom-2", envFor({ FAKE_RUN: "oom" }), 30);
    expect(ran).toStrictEqual({ exitCode: 137, timedOut: false, deadline: false, state: ended(137) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "infra", reason: killedUnflagged("1g") });
    expect(containerOutcome({ ...ran, ranAtMostMs: 10 }, { ...limits, pinned: { seconds: 60, memory: "64m" } })).toEqual({ outcome: "fail", reason: exitedWith(137) });
  });

  it("reads a state without an out-of-memory flag as unflagged, and refuses a flag that is neither true nor false", async () => {
    const bare = (code: number) => `{"Running":false,"ExitCode":${code},"Error":"","StartedAt":"2026-01-01T00:00:00Z"}`;
    const passed = await runContainer(["image"], "bare-1", envFor({ FAKE_RUN: "slow", FAKE_STATE: bare(0) }), 30);
    expect(passed).toStrictEqual({ exitCode: 0, timedOut: false, deadline: false, state: ended(0) });
    expect(containerOutcome(passed, limits)).toEqual({ outcome: "pass" });
    const failed = await runContainer(["image"], "bare-2", envFor({ FAKE_RUN: "exit", FAKE_STATE: bare(3) }), 30);
    expect(containerOutcome(failed, limits)).toEqual({ outcome: "fail", reason: exitedWith(3) });
    const killed = await runContainer(["image"], "bare-3", envFor({ FAKE_RUN: "oom", FAKE_STATE: bare(137) }), 30);
    expect(containerOutcome(killed, limits)).toEqual({ outcome: "infra", reason: killedUnflagged("1g") });
    for (const flag of ['"yes"', "1", "null"]) {
      const odd = `{"Running":false,"ExitCode":0,"OOMKilled":${flag},"Error":"","StartedAt":"2026-01-01T00:00:00Z"}`;
      const ran = await runContainer(["image"], "bare-4", envFor({ FAKE_RUN: "slow", FAKE_STATE: odd }), 30);
      expect(ran.state, flag).toBeNull();
      expect(containerOutcome(ran, limits).outcome, flag).toBe("infra");
    }
  });

  it("counts docker's out-of-memory flag even when the container's shell survives and exits otherwise", async () => {
    const killed = '{"Running":false,"ExitCode":3,"OOMKilled":true,"Error":"","StartedAt":"2026-01-01T00:00:00Z"}';
    const ran = await runContainer(["image"], "oom-3", envFor({ FAKE_RUN: "exit", FAKE_STATE: killed }), 30);
    expect(ran).toStrictEqual({ exitCode: 3, timedOut: false, deadline: false, state: ended(3, { oomKilled: true }) });
    expect(containerOutcome(ran, limits)).toEqual({ outcome: "infra", reason: oomInfra("1g") });
  });

  it("under a pinned timeout, stops and fails a container its own clock saw still running at the timeout", async () => {
    const started = performance.now();
    const ran = await runContainer(["image"], "pin-1", envFor({ FAKE_RUN: "hang", FAKE_KILL: "stops", FAKE_STATUS: "running" }), 30, 30, 0.2);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(ran).toStrictEqual({ exitCode: null, timedOut: false, deadline: false, state: null, overran: true, ranAtMostMs: expect.any(Number) });
    expect(containerOutcome(ran, { ...limits, pinned: { seconds: 0.2 } })).toEqual({ outcome: "fail", reason: ranPastPin(0.2) });
    const asked = await calls();
    expect(asked).toContain("run --name pin-1 image");
    expect(asked).toContain("kill pin-1");
    expect(asked.indexOf("kill pin-1")).toBeGreaterThan(asked.lastIndexOf("container inspect --format {{.State.Status}} pin-1"));
  });

  it("under a pinned timeout, keeps a container never seen running until --timeout infra", async () => {
    const ran = await runContainer(["image"], "pin-2", envFor({ FAKE_RUN: "hang", FAKE_KILL: "stops", FAKE_STATUS: "created" }), 0.5, 30, 0.2);
    expect(ran).toMatchObject({ timedOut: true, deadline: true, state: null, overran: false });
    expect(containerOutcome(ran, { ...limits, seconds: 0.5, pinned: { seconds: 0.2 } })).toEqual({ outcome: "infra", reason: timedOutInfra(0.5) });
  });

  it("under a pinned timeout, judges by exit code a container that ended sooner on its own clock, whatever Docker's times say, and only then", async () => {
    const backwards = (code: number, oom = false) =>
      `{"Running":false,"ExitCode":${code},"OOMKilled":${oom},"Error":"","StartedAt":"2026-01-01T00:00:05Z","FinishedAt":"2026-01-01T00:00:01Z"}`;
    const pins = (seconds: number) => ({ ...limits, pinned: { seconds, memory: "64m" } });
    const passed = await runContainer(["image"], "back-1", envFor({ FAKE_RUN: "exit", FAKE_STATE: backwards(0) }), 30, 30, 60);
    expect(passed).toMatchObject({ state: ended(0), overran: false });
    expect(passed.ranAtMostMs).toBeLessThan(60_000);
    expect(containerOutcome(passed, pins(60))).toEqual({ outcome: "pass" });
    const failed = await runContainer(["image"], "back-2", envFor({ FAKE_RUN: "exit" }), 30, 30, 60);
    expect(containerOutcome(failed, pins(60))).toEqual({ outcome: "fail", reason: exitedWith(3) });
    const killed = await runContainer(["image"], "back-3", envFor({ FAKE_RUN: "exit", FAKE_STATE: backwards(137, true) }), 30, 30, 60);
    expect(containerOutcome(killed, pins(60))).toEqual({ outcome: "fail", reason: oomPinned("64m") });
    expect(containerOutcome(killed, { ...limits, pinned: { seconds: 60 } })).toEqual({ outcome: "infra", reason: oomInfra("1g") });
    for (const fake of [{ FAKE_RUN: "slow", FAKE_STATE: backwards(0) }, { FAKE_RUN: "slow", FAKE_STATUS: "dead" }]) {
      const long = await runContainer(["image"], "back-4", envFor(fake), 30, 30, 0.2);
      expect(long.ranAtMostMs ?? 0, JSON.stringify(fake)).toBeGreaterThanOrEqual(200);
      expect(containerOutcome(long, pins(0.2)), JSON.stringify(fake)).toEqual({ outcome: "infra", reason: RUN_UNTIMED });
      expect(containerOutcome(long, pins(60)), JSON.stringify(fake)).toEqual({ outcome: "pass" });
    }
    expect((await runContainer(["image"], "back-5", envFor({ FAKE_RUN: "exit" }), 30)).state).toStrictEqual(ended(3));
  });

  it("shows what the container prints only with its control characters escaped", async () => {
    expect(await runContainer(["image"], "noisy-1", envFor({ FAKE_RUN: "noisy" }), 30)).toStrictEqual({ exitCode: 0, timedOut: false, deadline: false, state: ended(0) });
    const shown = warned.join("");
    expect(shown).toContain("line\\u001b[2J\\u000d\\u202eend\n");
    expect(shown).not.toMatch(/[\u001b\r‮]/u);
  });
});
