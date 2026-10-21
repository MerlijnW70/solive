import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leftRunning, stillRunning, sweep, taskkill, type Watch } from "../src/process-reap.js";
import { statOf } from "../src/process-table.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readlink: vi.fn(actual.readlink) };
});

const LISTER = (name: string) => `#!/bin/sh
printf '%s' "$FAKE_${name}_OUT"
exit "\${FAKE_${name}_CODE:-1}"
`;

const NO_SESSION = 4_000_000;

let dir = "";
let warned: string[] = [];
const children: ChildProcess[] = [];
const path = process.env["PATH"];

const sleeper = (cwd: string): number => {
  const child = spawn("sleep", ["60"], { cwd, stdio: "ignore" });
  children.push(child);
  return child.pid ?? 0;
};

const startedOf = (pid: number): number => statOf(pid)?.started ?? -1;

const watching = (fields: Partial<Watch>): Watch => ({
  pid: NO_SESSION,
  started: null,
  recorded: { started: new Map(), leaders: new Map() },
  alive: false,
  marker: undefined,
  cwd: undefined,
  ...fields,
});

describe.skipIf(process.platform !== "linux")("the sweep after a check", () => {
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "process-reap-")));
    for (const name of ["pgrep", "ps"]) {
      await writeFile(join(dir, name), LISTER(name.toUpperCase()));
      await chmod(join(dir, name), 0o755);
    }
    warned = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(readlink).mockReset();
    process.env["PATH"] = path;
    for (const key of ["FAKE_PGREP_OUT", "FAKE_PGREP_CODE", "FAKE_PS_OUT", "FAKE_PS_CODE"]) {
      delete process.env[key];
    }
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  });

  const listing = (pgrep: [string, number], ps: [string, number]) => {
    process.env["PATH"] = `${dir}:${path ?? ""}`;
    process.env["FAKE_PGREP_OUT"] = pgrep[0];
    process.env["FAKE_PGREP_CODE"] = String(pgrep[1]);
    process.env["FAKE_PS_OUT"] = ps[0];
    process.env["FAKE_PS_CODE"] = String(ps[1]);
  };

  it("without a process table reports the session members pgrep lists, but never the session leader or the judge", async () => {
    listing([`${NO_SESSION}\n${process.pid}\n4000001\n4000002\n4000001\n`, 0], ["", 1]);
    expect(await sweep(watching({}), true)).toEqual([4000001, 4000002]);
    expect(warned).toEqual([`${leftRunning([4000001, 4000002])}\n`]);
  });

  it("asks ps when pgrep fails, and warns about nothing when no member is left", async () => {
    listing(["", 2], [" 4000003\n", 0]);
    expect(await sweep(watching({}), true)).toEqual([4000003]);
    expect(warned).toEqual([`${leftRunning([4000003])}\n`]);
    warned.length = 0;
    listing(["", 1], ["4000004\n", 0]);
    expect(await sweep(watching({}), true)).toEqual([]);
    expect(warned).toEqual([]);
  });

  it("reports a process that escaped into the check's directory, from the check's start on, and nothing older or elsewhere", async () => {
    const inner = join(dir, "inner");
    await mkdir(inner);
    const empty = await realpath(await mkdtemp(join(tmpdir(), "process-reap-empty-")));
    const older = sleeper(dir);
    await new Promise((done) => setTimeout(done, 60));
    const first = sleeper(dir);
    await new Promise((done) => setTimeout(done, 60));
    const nested = sleeper(inner);
    const elsewhere = sleeper(tmpdir());
    const hidden = sleeper(dir);
    await vi.waitFor(async () => expect(await Promise.all([first, nested, hidden].map((pid) => readlink(`/proc/${pid}/cwd`)))).toEqual([dir, inner, dir]), { timeout: 2_000 });
    expect(startedOf(older)).toBeLessThan(startedOf(first));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readlink).mockImplementation(async (at) => {
      if (at === `/proc/${hidden}/cwd`) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return actual.readlink(String(at));
    });
    const escaped = await sweep(watching({ started: startedOf(first), cwd: dir }), true);
    expect([...escaped].sort((a, b) => a - b)).toEqual([first, nested].sort((a, b) => a - b));
    expect(warned).toEqual([`${leftRunning(escaped)}\n`]);
    expect(elsewhere).toBeGreaterThan(0);
    warned.length = 0;
    expect(await sweep(watching({ started: startedOf(first), cwd: empty }), true)).toEqual([]);
    expect(warned).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });

  it("kills the check's processes for ten rounds with growing pauses, then names those still running", async () => {
    const stubborn = sleeper(dir);
    const started = startedOf(stubborn);
    const kills = vi.spyOn(process, "kill").mockImplementation(() => true);
    const pauses = vi.spyOn(globalThis, "setTimeout");
    const watch = watching({ pid: stubborn, started, recorded: { started: new Map([[stubborn, started]]), leaders: new Map() } });
    expect(await sweep(watch, false)).toEqual([]);
    expect(kills.mock.calls).toEqual(Array.from({ length: 10 }, () => [stubborn, "SIGKILL"]));
    expect(pauses.mock.calls.map(([, ms]) => ms)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(warned).toEqual([`${stillRunning([stubborn])}\n`]);
  });

  it("hides the window of taskkill", async () => {
    await taskkill(4000005);
    expect(vi.mocked(spawn).mock.calls.at(-1)).toEqual(["taskkill", ["/pid", "4000005", "/T", "/F"], { stdio: "ignore", windowsHide: true }]);
  });
});
