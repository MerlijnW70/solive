import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweep, type Watch } from "../src/process-reap.js";
import { statOf } from "../src/process-table.js";

const hidden = new Set<string>();

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (hidden.has(String(args[0]))) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), { code: "EACCES" });
      }
      return actual.readFile(...args);
    }),
  };
});

const NO_SESSION = 4_000_000;
const MARKER = "KILL_CLI_JUDGE_SURVIVORS_MARK=1";

const children: ChildProcess[] = [];

describe.skipIf(process.platform !== "linux")("the sweep with a marker it cannot read", () => {
  afterEach(() => {
    hidden.clear();
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
  });

  it("does not tie a process to the check when its environment cannot be read, even from the check's directory", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "kill-reap-")));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const child = spawn("sleep", ["60"], { cwd: dir, stdio: "ignore" });
      children.push(child);
      const pid = child.pid ?? 0;
      const started = statOf(pid)?.started ?? -1;
      const watch = (marker: string | undefined): Watch => ({
        pid: NO_SESSION,
        started,
        recorded: { started: new Map(), leaders: new Map() },
        alive: false,
        marker,
        cwd: dir,
      });
      expect(await sweep(watch(undefined), true)).toContain(pid);
      hidden.add(`/proc/${pid}/environ`);
      await expect(readFile(`/proc/${pid}/environ`, "utf8")).rejects.toThrow("EACCES");
      expect(await sweep(watch(MARKER), true)).not.toContain(pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
