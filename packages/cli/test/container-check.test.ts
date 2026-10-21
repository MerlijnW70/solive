import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerLeft, docker, removeContainer, runContainer } from "../src/check-process.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls"
case "$1" in
  version) echo "fake docker 1.0"; exit 0 ;;
  rm) exit 0 ;;
  container) exit "\${FAKE_INSPECT:-1}" ;;
  kill)
    if [ "$FAKE_KILL" = stops ]; then kill -USR1 "$(cat "$FAKE_DIR/$2.pid")"; fi
    exit 0 ;;
  run)
    echo $$ > "$FAKE_DIR/$3.pid"
    case "$FAKE_RUN" in
      exit) exit 3 ;;
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
    expect(await calls()).toEqual(["rm -f left-1", "container inspect left-1", "rm -f gone-1", "container inspect gone-1"]);
  });

  it("reports the exit code of a container that ends by itself, then removes it", async () => {
    expect(await runContainer(["image"], "ends-1", envFor({ FAKE_RUN: "exit" }), 30)).toStrictEqual({ exitCode: 3, timedOut: false });
    expect(spawned()[0]).toEqual({
      file: "docker",
      args: ["run", "--name", "ends-1", "image"],
      options: expect.objectContaining({ stdio: ["ignore", 2, 2], detached: process.platform !== "win32", windowsHide: true }),
    });
    expect(await calls()).toEqual(["run --name ends-1 image", "rm -f ends-1", "container inspect ends-1"]);
    expect(warned).toEqual([]);
  });

  it("counts --timeout in seconds, so a container that ends within it is not stopped", async () => {
    expect(await runContainer(["image"], "slow-1", envFor({ FAKE_RUN: "slow" }), 5)).toStrictEqual({ exitCode: 0, timedOut: false });
    expect(await calls()).toEqual(["run --name slow-1 image", "rm -f slow-1", "container inspect slow-1"]);
  });

  it("stops a container at the timeout and reports no exit code, even when docker kill ends it with one", async () => {
    expect(await runContainer(["image"], "late-1", envFor({ FAKE_RUN: "hang", FAKE_KILL: "stops" }), 0.2)).toStrictEqual({ exitCode: null, timedOut: true });
    expect(await calls()).toEqual(["run --name late-1 image", "kill late-1", "rm -f late-1", "rm -f late-1", "container inspect late-1"]);
  });

  it("kills the docker client itself when docker kill does not end it", async () => {
    const started = Date.now();
    expect(await runContainer(["image"], "stuck-1", envFor({ FAKE_RUN: "hang" }), 0.2)).toStrictEqual({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await calls()).toEqual(["run --name stuck-1 image", "kill stuck-1", "rm -f stuck-1", "rm -f stuck-1", "container inspect stuck-1"]);
  }, 30_000);
});
