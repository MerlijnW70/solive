import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { CLEANUP_RETRIES, leftRunning, runCheck } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { artifactTooLarge, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES } from "../src/artifact.js";
import { cli } from "./harness.js";
import { job, type Job, judging, status, TIMEOUT_SECONDS } from "./judge-kit.js";

const removal = vi.hoisted(() => ({ refused: false, retries: [] as (number | undefined)[] }));
const writing = vi.hoisted(() => ({ before: null as ((path: string) => Promise<void>) | null }));
const proc = vi.hoisted(() => ({ hidden: false }));
const opening = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (proc.hidden && String(args[0]) === "/proc") {
        throw Object.assign(new Error("ENOENT: no such file or directory, scandir '/proc'"), { code: "ENOENT" });
      }
      return actual.readdir(...args);
    }) as typeof actual.readdir,
    open: (async (...args: Parameters<typeof actual.open>) => {
      opening.paths.push(String(args[0]));
      return actual.open(...args);
    }) as typeof actual.open,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await writing.before?.(String(args[0]));
      return actual.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const [path, options] = args;
      if (removal.refused && String(path).includes("judge-artifact-")) {
        removal.retries.push(options?.maxRetries);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(path)}'`), { code: "EBUSY" });
      }
      return actual.rm(...args);
    },
  };
});

describe("intent-engine judge", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("interrupts after the release confirms still write the verdict", async () => {
    const verdict = join(j.dir, "verdict.json");
    const others = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    const exits = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      let emitted = false;
      writing.before = async (path) => {
        if (path !== verdict) {
          return;
        }
        writing.before = null;
        emitted = true;
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await new Promise((wake) => setTimeout(wake, 500));
      };
      const ended = await cli(judging(j, "true", "--verdict", verdict, "--yes"), keys);
      expect(emitted).toBe(true);
      expect([ended.code, ended.out]).toEqual([130, ""]);
      const written = JSON.parse(await readFile(verdict, "utf8"));
      expect(written).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
      expect(ended.err).toContain(`it was sent in ${written.signature} and the verdict was written to ${verdict}`);
      expect(ended.err).not.toContain("may have landed");
      await new Promise((wake) => setTimeout(wake, 300));
      expect(exits).not.toHaveBeenCalled();
      expect(status(j.intent)).toBe(IntentStatus.Filled);
      expect(process.listenerCount("SIGINT")).toBe(0);
    } finally {
      writing.before = null;
      exits.mockRestore();
      for (const listener of others) {
        process.on("SIGINT", listener as NodeJS.SignalsListener);
      }
    }
  });

  it("an artifact over the size or file limit is refused before its contents are read", { timeout: 60_000 }, async () => {
    expect([MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES]).toEqual([67108864, 10000]);
    const dir = await mkdtemp(join(tmpdir(), "limits-"));
    const big = join(dir, "big.bin");
    await writeFile(big, "");
    await truncate(big, MAX_ARTIFACT_BYTES + 1);
    const heavy = join(dir, "heavy");
    await mkdir(heavy);
    for (const name of ["a.bin", "b.bin"]) {
      await writeFile(join(heavy, name), "");
      await truncate(join(heavy, name), MAX_ARTIFACT_BYTES / 2 + 1);
    }
    const many = join(dir, "many");
    await mkdir(many);
    for (let at = 0; at <= MAX_ARTIFACT_FILES; at += 500) {
      await Promise.all(Array.from({ length: Math.min(500, MAX_ARTIFACT_FILES + 1 - at) }, (_, i) => writeFile(join(many, `f${at + i}`), "x")));
    }
    opening.paths = [];
    const cases = [
      [big, `is larger than ${MAX_ARTIFACT_BYTES} bytes`],
      [heavy, `holds more than ${MAX_ARTIFACT_BYTES} bytes`],
      [many, `holds more than ${MAX_ARTIFACT_FILES} files`],
    ] as const;
    for (const [artifact, over] of cases) {
      const hashed = await cli(["hash", "--artifact", artifact], {});
      expect(hashed).toMatchObject({ code: EXIT_USAGE, out: "", err: artifactTooLarge(artifact, over) });
      expect(hashed.err).toContain("nothing was run or paid");
      const marker = join(j.dir, "ran");
      const args = judging(j, `touch "${marker}"`, "--yes");
      args[args.indexOf("--artifact") + 1] = artifact;
      const judged = await cli(args, keys);
      expect(judged).toMatchObject({ code: EXIT_USAGE, out: "", err: artifactTooLarge(resolve(artifact), over) });
      expect(existsSync(marker)).toBe(false);
    }
    expect(opening.paths.filter((path) => path.startsWith(dir))).toEqual([]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    await rm(dir, { recursive: true, force: true });
  });

  it("a cleanup failure does not hide the verdict", async () => {
    const seen = join(j.dir, "seen");
    removal.retries = [];
    removal.refused = true;
    const run = await cli(judging(j, `pwd -P > "${seen}"`, "--verdict", join(j.dir, "verdict.json")), keys).finally(() => {
      removal.refused = false;
    });
    const copy = (await readFile(seen, "utf8")).trim();
    expect(existsSync(copy)).toBe(true);
    await rm(copy, { recursive: true, force: true });
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", exitCode: 0, payTo: j.worker.address, cleanup: expect.stringContaining("could not be removed") });
    expect(JSON.parse(await readFile(join(j.dir, "verdict.json"), "utf8"))).toEqual(run.json());
    expect(removal.retries.length).toBeGreaterThan(0);
    for (const retries of removal.retries) {
      expect(retries).toBeGreaterThanOrEqual(5);
    }
    expect(CLEANUP_RETRIES).toBeGreaterThanOrEqual(5);

    const failed = await cli(judging(j, "exit 4"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", exitCode: 4 });
    expect(failed.json()).not.toHaveProperty("cleanup");
  });
});

describe("the artifact hash", () => {
  it("without proc leftovers after exit are reported", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-noproc-"));
    const pidFile = join(dir, "left");
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    let left = 0;
    proc.hidden = true;
    try {
      const check = await runCheck(`sleep 600 > /dev/null 2>&1 &\necho $! > "${pidFile}"\nexit 0`, process.env, TIMEOUT_SECONDS * 10, { cwd: dir });
      left = Number(await readFile(pidFile, "utf8"));
      expect(check).toEqual({ exitCode: 0, timedOut: false, escaped: [left] });
      expect(warned.join("")).toContain(leftRunning([left]));
      expect(() => process.kill(left, 0)).not.toThrow();
    } finally {
      proc.hidden = false;
      writes.mockRestore();
      if (left > 0) {
        spawnSync("kill", ["-KILL", String(left)]);
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
