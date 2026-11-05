import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aliveAt, claimRoot, OWNER_FILE, RUN_ROOT_PREFIX, removeRoot, SCRATCH_DIR, startOf, sweepStale } from "./run-root.js";
import setup from "./run-root-setup.js";

const SAVED = ["TMPDIR", "TMP", "TEMP"].map((name) => [name, process.env[name]] as const);
let base = "";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "run-root-test-"));
});

afterEach(() => {
  for (const [name, value] of SAVED) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(base, { recursive: true, force: true });
});

async function sleeper(): Promise<{ pid: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("the child did not start");
  }
  expect(aliveAt(pid, "")).toBe(true);
  return {
    pid,
    kill: () =>
      new Promise((done) => {
        child.once("exit", () => done());
        child.kill("SIGKILL");
      }),
  };
}

describe("a run root", () => {
  it("is named after its owner and holds an owner record and a scratch directory", () => {
    const root = claimRoot(base);
    expect(root.startsWith(join(base, `${RUN_ROOT_PREFIX}${process.pid}-`))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, OWNER_FILE), "utf8"))).toEqual({ pid: process.pid, started: startOf(process.pid) });
    expect(lstatSync(join(root, SCRATCH_DIR)).isDirectory()).toBe(true);
    expect([lstatSync(root).mode & 0o7777, lstatSync(join(root, SCRATCH_DIR)).mode & 0o7777]).toEqual([0o711, 0o1777]);
  });

  it("is removed whole by its owner, and a path that is not a root is never removed", () => {
    const root = claimRoot(base);
    const foreign = join(base, "keep");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "file"), "x");
    expect(removeRoot(base, foreign)).toBe(false);
    expect(removeRoot("", root)).toBe(false);
    expect(removeRoot(join(base, "elsewhere"), root)).toBe(false);
    expect(existsSync(join(foreign, "file"))).toBe(true);
    expect(removeRoot(base, root)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });

  it("is swept when its owner was killed, while a live owner's root and foreign entries stay", async () => {
    const dying = await sleeper();
    const living = await sleeper();
    const stale = claimRoot(base, dying.pid);
    const alive = claimRoot(base, living.pid);
    const mine = claimRoot(base);
    writeFileSync(join(stale, SCRATCH_DIR, "leftover"), "x");
    const closed = join(stale, SCRATCH_DIR, "closed");
    mkdirSync(closed);
    writeFileSync(join(closed, "file"), "x");
    chmodSync(closed, 0o000);
    const foreign = mkdtempSync(join(base, "tmp-other-"));
    writeFileSync(join(foreign, "file"), "x");
    const lookalike = join(base, `${RUN_ROOT_PREFIX}${dying.pid}-AAAAAA`);
    mkdirSync(lookalike);
    writeFileSync(join(lookalike, "file"), "x");
    const victim = mkdtempSync(join(base, "victim-"));
    writeFileSync(join(victim, "file"), "x");
    const linked = join(base, `${RUN_ROOT_PREFIX}${dying.pid}-BBBBBB`);
    symlinkSync(victim, linked);
    await dying.kill();
    try {
      const removed = sweepStale(base);
      expect(removed).toEqual([stale]);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(alive)).toBe(true);
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(join(foreign, "file"))).toBe(true);
      expect(existsSync(join(lookalike, "file"))).toBe(true);
      expect(existsSync(join(victim, "file"))).toBe(true);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(readdirSync(base).sort()).toEqual([alive, mine, foreign, lookalike, victim, linked].map((path) => path.slice(base.length + 1)).sort());
    } finally {
      await living.kill();
    }
    expect(sweepStale(base)).toEqual([alive]);
    expect(existsSync(mine)).toBe(true);
  });

  it("is swept when its pid now belongs to another process", () => {
    const root = claimRoot(base);
    writeFileSync(join(root, OWNER_FILE), JSON.stringify({ pid: process.pid, started: "1" }));
    expect(sweepStale(base)).toEqual([root]);
  });

  it("is left alone when the pid in its name is not a plain pid", () => {
    for (const pid of ["0", "1"]) {
      const root = join(base, `${RUN_ROOT_PREFIX}${pid}-CCCCCC`);
      mkdirSync(root);
      writeFileSync(join(root, OWNER_FILE), JSON.stringify({ pid: Number(pid), started: "" }));
      expect(sweepStale(base)).toEqual([]);
      expect(existsSync(root)).toBe(true);
    }
  });

  it("is made by the setup of every package, points the temp variables into it and is gone after the teardown", () => {
    process.env["TMPDIR"] = base;
    const finish = setup();
    const [name] = readdirSync(base);
    const scratch = join(base, name ?? "", SCRATCH_DIR);
    expect([process.env["TMPDIR"], process.env["TMP"], process.env["TEMP"]]).toEqual([scratch, scratch, scratch]);
    expect(tmpdir()).toBe(scratch);
    writeFileSync(join(mkdtempSync(join(tmpdir(), "inside-")), "file"), "x");
    finish();
    expect(readdirSync(base)).toEqual([]);
  });
});
