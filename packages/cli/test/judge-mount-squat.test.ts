import { spawn, spawnSync } from "node:child_process";
import { readlinkSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { judgeRoot, MOUNT_BASE, MOUNT_DIR, mountBase, removeCopy, slotLock } from "../src/artifact.js";

const PLACES = ["TMPDIR", "HOME", "XDG_RUNTIME_DIR"] as const;
const SQUAT_MS = 6_000;
const MIN_TAKES = 20;
const HOLD_MS = 50;
const SHARED_TMP = 0o1777;

const SQUATTER = `const fs = require("node:fs");
const net = require("node:net");
const seen = new Set();
const refused = new Set();
const end = Date.now() + Number(process.argv[1]);
const loop = () => {
  for (const line of fs.readFileSync("/proc/net/unix", "utf8").split("\\n")) {
    const name = line.match(/@(\\S*judge-mounts\\S*)/)?.[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      net.createServer().on("error", () => undefined).listen({ path: "\\0" + name });
    }
  }
  for (const pid of fs.readdirSync("/proc").filter((entry) => /^\\d+$/.test(entry))) {
    let args = [];
    try {
      args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0");
    } catch {
      continue;
    }
    for (const arg of args.filter((part) => part.includes("judge-mounts") && part.endsWith(".lock"))) {
      seen.add(arg);
      try {
        fs.closeSync(fs.openSync(arg, "r"));
        require("node:child_process").spawn("flock", ["-n", arg, "sleep", "30"], { detached: true, stdio: "ignore" }).unref();
      } catch (error) {
        refused.add(arg + " " + error.code);
      }
    }
  }
  if (Date.now() < end) {
    setTimeout(loop, 10);
  } else {
    process.stdout.write(JSON.stringify({ seen: [...seen], refused: [...refused] }));
    process.exit(0);
  }
};
loop();`;

const NOBODY = process.platform === "linux" && spawnSync("sudo", ["-n", "-u", "nobody", process.execPath, "-e", "0"], { cwd: "/", stdio: "ignore", timeout: 10_000 }).status === 0;

describe("judge mount slots against another local user", () => {
  it("a second user who pre-creates every slot base name it can reach, then watches /proc for lock names and squats each one, leaves every run a slot", { timeout: 60_000 }, async (context) => {
    if (!NOBODY) {
      context.skip("needs Linux and sudo -n -u nobody able to run this Node binary, to run the squatter as a second user");
    }
    const saved = Object.fromEntries(PLACES.map((name) => [name, process.env[name]]));
    const scratch = await mkdtemp(join(tmpdir(), "mount-squat-"));
    await chmod(scratch, SHARED_TMP);
    await mkdir(join(scratch, "home"), { mode: 0o700 });
    await mkdir(join(scratch, "run"), { mode: 0o700 });
    process.env["TMPDIR"] = scratch;
    process.env["HOME"] = join(scratch, "home");
    process.env["XDG_RUNTIME_DIR"] = join(scratch, "run");
    const space = readlinkSync("/proc/self/ns/net").replace(/\D/g, "");
    const reachable = [`${MOUNT_BASE}${process.getuid?.()}-${space}`, `${MOUNT_BASE}${space}`, MOUNT_DIR, ".cache"].map((name) => join(scratch, name));
    for (const path of reachable) {
      spawnSync("sudo", ["-n", "-u", "nobody", "mkdir", "-m", "700", path], { stdio: "ignore" });
      expect(statSync(path).uid, path).not.toBe(process.getuid?.());
    }
    const written: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    try {
      const squatter = spawn("sudo", ["-n", "-u", "nobody", process.execPath, "-e", SQUATTER, String(SQUAT_MS)], { cwd: "/", stdio: ["ignore", "pipe", "inherit"] });
      let report = "";
      squatter.stdout.setEncoding("utf8");
      squatter.stdout.on("data", (chunk: string) => {
        report += chunk;
      });
      const ended = new Promise<void>((done) => squatter.once("exit", () => done()));
      let over = false;
      void ended.then(() => {
        over = true;
      });
      const slots: string[] = [];
      const deadline = Date.now() + SQUAT_MS * 2;
      while (!over && Date.now() < deadline) {
        const root = await judgeRoot("judge-artifact-", true);
        slots.push(basename(root));
        await new Promise((wake) => setTimeout(wake, HOLD_MS));
        await removeCopy(root);
      }
      expect(over, "the squatter ended in time").toBe(true);
      await ended;
      const { seen, refused } = JSON.parse(report) as { seen: string[]; refused: string[] };
      const lock = slotLock((await mountBase()) ?? "", 0);
      expect(slots.length).toBeGreaterThanOrEqual(MIN_TAKES);
      expect(new Set(slots)).toEqual(new Set(["slot-0"]));
      expect(written.join("")).toBe("");
      expect(seen).toContain(lock);
      expect(seen.filter((name) => !name.startsWith("/"))).toEqual([]);
      expect(refused).toContain(`${lock} EACCES`);
    } finally {
      writes.mockRestore();
      spawnSync("sudo", ["-n", "-u", "nobody", "pkill", "-KILL", "-f", `flock -n ${scratch}/`], { stdio: "ignore" });
      for (const name of PLACES) {
        const value = saved[name];
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
