import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { manifestSha256 } from "@intent-engine/core/internal";
import {
  artifactSha256,
  checkEnv,
  claim,
  ENV_SPEC_PATH,
  leftRunning,
  type Recorded,
  runCheck,
  type Running,
  SPEC_COPY,
} from "../src/judge.js";
import { alive, PROCESS_WAIT, STARTUP_SECONDS, TIMEOUT_SECONDS } from "./judge-kit.js";

describe("the artifact hash", () => {
  it("hashes a file by its bytes alone, whatever its name, a directory as a manifest, and refuses links and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-"));
    await writeFile(join(dir, "work.tar"), "bytes");
    await writeFile(join(dir, "renamed"), "bytes");
    expect(await artifactSha256(join(dir, "work.tar"))).toBe(createHash("sha256").update("bytes").digest("hex"));
    expect(await artifactSha256(join(dir, "renamed"))).toBe(await artifactSha256(join(dir, "work.tar")));
    await mkdir(join(dir, "tree"));
    await writeFile(join(dir, "tree", "a"), "1");
    expect(await artifactSha256(join(dir, "tree"))).toBe(await manifestSha256([{ path: "a", bytes: new TextEncoder().encode("1") }]));
    await symlink(join(dir, "work.tar"), join(dir, "tree", "link"));
    await expect(artifactSha256(join(dir, "tree"))).rejects.toThrow("the artifact holds link, which is neither a regular file nor a directory");
    await expect(artifactSha256(join(dir, "missing"))).rejects.toThrow();
  });

  it("runs the command with the environment it is given and reports its exit code", async () => {
    expect(await runCheck('test "$ARTIFACT_SHA256" = given && exit 4', { ...process.env, ARTIFACT_SHA256: "given" }, TIMEOUT_SECONDS * 10)).toEqual({ exitCode: 4, timedOut: false });
    expect(await runCheck("sleep 600", process.env, TIMEOUT_SECONDS)).toEqual({ exitCode: null, timedOut: true });
  });

  it("the kill walk never kills a process that reused the check pid", () => {
    const check = 4000;
    const entry = (pid: number, parent: number, group: number, session: number, started: number): Running => ({ pid, parent, group, session, started, zombie: false });
    const recorded: Recorded = { started: new Map([[check, 100], [4001, 101], [4002, 102]]), leaders: new Map([[check, 100], [4001, 101], [4002, 102]]) };
    const reuser = [entry(check, 1, check, check, 900), entry(4100, check, check, check, 901), entry(4101, 4100, 4101, check, 902)];
    const ours = [entry(4001, 1, 4001, 4001, 101), entry(4003, 4001, 4001, 4001, 150), entry(4004, 1, 4004, 4001, 160), entry(4005, 1, 4005, 4002, 170)];
    const older = entry(4006, 1, 4006, 4002, 90);
    const pids = (table: Running[]) => claim(table, recorded).map((running) => running.pid);
    expect(pids([...reuser, ...ours, older])).toEqual([4001, 4003, 4004, 4005]);
    expect(recorded.started.has(check)).toBe(false);
    const orphans = [entry(4100, 1, check, check, 901), entry(4101, 1, 4101, check, 902)];
    expect(pids([...orphans, ...ours])).toEqual([4001, 4003, 4004, 4005]);
  });

  it("a reused pid that was never a session leader of the check is not killed", () => {
    const check = 5000;
    const entry = (pid: number, parent: number, group: number, session: number, started: number): Running => ({ pid, parent, group, session, started, zombie: false });
    const recorded: Recorded = { started: new Map([[check, 100]]), leaders: new Map([[check, 100]]) };
    const pids = (table: Running[]) => claim(table, recorded).map((running) => running.pid);
    expect(pids([entry(check, 1, check, check, 100), entry(5001, check, check, check, 110)])).toEqual([check, 5001]);
    expect([...recorded.leaders.keys()]).toEqual([check]);
    const daemon = entry(5100, 1, 5100, 5001, 400);
    const grandchild = entry(5101, 5100, 5100, 5001, 410);
    expect(pids([entry(check, 1, check, check, 100), daemon, grandchild])).toEqual([check]);
    const leftover = entry(5200, 1, 5200, check, 300);
    expect(pids([leftover, daemon, grandchild])).toEqual([5200]);
  });

  it("an escaped process is reported, not ignored", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-escape-"));
    const caught = join(dir, "caught");
    const go = join(dir, "go");
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    let escaped = 0;
    let stayed = 0;
    try {
      const run = [`sh -c 'echo $$ > "${caught}.tmp"; mv "${caught}.tmp" "${caught}"; exec sleep 600' &`, `while ! test -e "${go}"; do sleep 0.01; done`].join("\n");
      const env = checkEnv(process.env, join(dir, SPEC_COPY), dir, "ab");
      const checking = runCheck(run, env, STARTUP_SECONDS * 20, { cwd: dir });
      await vi.waitFor(() => expect(existsSync(caught)).toBe(true), PROCESS_WAIT);
      const outside = spawn("sleep", ["600"], { env, cwd: dir, detached: true, stdio: "ignore" });
      outside.unref();
      escaped = outside.pid ?? 0;
      expect(escaped).toBeGreaterThan(0);
      await vi.waitFor(() => expect(readFileSync(`/proc/${escaped}/environ`, "utf8").split("\0")).toContain(`${ENV_SPEC_PATH}=${env[ENV_SPEC_PATH]}`), PROCESS_WAIT);
      await writeFile(go, "");
      const check = await checking;
      stayed = Number(await readFile(caught, "utf8"));
      expect(check).toEqual({ exitCode: 0, timedOut: false, escaped: [escaped] });
      expect(warned.join("")).toContain(leftRunning([escaped]));
      await vi.waitFor(() => expect(alive(stayed)).toBe(false), PROCESS_WAIT);
      expect(alive(escaped)).toBe(true);
    } finally {
      writes.mockRestore();
      for (const pid of [escaped, stayed]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          continue;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
