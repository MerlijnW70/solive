import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweep, type Watch } from "../src/process-reap.js";
import { statOf } from "../src/process-table.js";

const NO_SESSION = 4_000_000;

const children: ChildProcess[] = [];

describe.skipIf(process.platform !== "linux")("the sweep with neither a marker nor a directory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
  });

  it("never ties a running process to the check", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    children.push(child);
    const pid = child.pid ?? 0;
    const started = statOf(pid)?.started ?? -1;
    expect(started).toBeGreaterThanOrEqual(0);
    const watch: Watch = {
      pid: NO_SESSION,
      started,
      recorded: { started: new Map(), leaders: new Map() },
      alive: false,
      marker: undefined,
      cwd: undefined,
    };
    expect(await sweep(watch, true)).not.toContain(pid);
    expect(statOf(pid)).not.toBeNull();
  });
});
