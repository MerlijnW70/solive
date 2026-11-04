import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyOf, judgeRoot, MOUNT_BASE, MOUNT_DIR, MOUNT_FALLBACK, MOUNT_SLOTS, mountBase, readArtifact, removeCopy, slotLock } from "../src/artifact.js";
import { DESKTOP_BIND_MOUNTS, DESKTOP_COPIES, hostMounts, MOUNTS_NEAR, mountsNear, mountsOf } from "../src/sandbox-doctor.js";
import { OUTSIDE_MODE, planted } from "./slot-plant.js";

const BUILT = new URL("../dist/src/artifact.js", import.meta.url).href;
const CLEANUP_MS = 1_500;
const JUDGE = `const { judgeRoot, removeCopy } = await import(process.argv[1]);
const root = await judgeRoot("judge-artifact-", true);
process.on("SIGINT", () => {
  process.stdout.write("interrupted\\n");
  setTimeout(async () => {
    await removeCopy(root);
    process.stdout.write("cleaned\\n");
    process.exit(130);
  }, ${CLEANUP_MS});
});
process.stdout.write(root + "\\n");
setInterval(() => undefined, 1000);`;
const PLACES = ["TMPDIR", "HOME", "XDG_RUNTIME_DIR"] as const;

let saved: Partial<Record<(typeof PLACES)[number], string>> = {};
let scratch = "";
const children: ChildProcess[] = [];

type Judge = { child: ChildProcess; root: string; lines: string[] };

async function judging(): Promise<Judge> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", JUDGE, BUILT], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  children.push(child);
  const lines: string[] = [];
  child.stdout.setEncoding("utf8");
  const root = await new Promise<string>((done, failed) => {
    child.stdout.on("data", (chunk: string) => {
      lines.push(...chunk.split("\n").filter((line) => line !== ""));
      done(lines[0] ?? "");
    });
    child.once("exit", (code) => failed(new Error(`the judge ended with ${code}`)));
  });
  return { child, root, lines };
}

const until = async (done: () => boolean): Promise<void> => {
  for (let wait = 0; wait < 100 && !done(); wait += 1) {
    await new Promise((wake) => setTimeout(wake, 50));
  }
};

const holderOf = (judge: number): number | undefined =>
  spawnSync("pgrep", ["-P", String(judge), "flock"], { encoding: "utf8" })
    .stdout.split("\n")
    .map(Number)
    .find((pid) => pid > 0);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const groupOf = (pid: number): number => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[2]);

async function started(child: ChildProcess): Promise<ChildProcess> {
  children.push(child);
  await new Promise<void>((done, failed) => {
    child.stdout?.once("data", () => done());
    child.once("exit", (code) => failed(new Error(`the lock holder ended with ${code}`)));
  });
  return child;
}

const slotOf = (root: string): string => basename(root);

async function warnings<T>(run: () => Promise<T>): Promise<{ value: T; written: string }> {
  const written: string[] = [];
  const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    written.push(String(text));
    return true;
  });
  try {
    return { value: await run(), written: written.join("") };
  } finally {
    writes.mockRestore();
  }
}

async function takenAgain(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const root = await judgeRoot("judge-artifact-", true);
    if (slotOf(root) === "slot-0") {
      return root;
    }
    await removeCopy(root);
    await new Promise((wake) => setTimeout(wake, 100));
  }
  return "";
}

describe.skipIf(process.platform !== "linux")("judge mount slots", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(PLACES.map((name) => [name, process.env[name]]));
    scratch = await mkdtemp(join(tmpdir(), "mount-slots-"));
    await mkdir(join(scratch, "home"), { mode: 0o700 });
    await mkdir(join(scratch, "run"), { mode: 0o700 });
    process.env["TMPDIR"] = scratch;
    process.env["HOME"] = join(scratch, "home");
    process.env["XDG_RUNTIME_DIR"] = join(scratch, "run");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.pid !== undefined) {
        spawnSync("kill", ["-KILL", `-${child.pid}`]);
        child.kill("SIGKILL");
      }
    }
    for (const name of PLACES) {
      const value = saved[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    spawnSync("chmod", ["-R", "u+rwX", scratch]);
    await rm(scratch, { recursive: true, force: true });
  });

  it("hands each live run its own slot, private to the judge, and the next run the slot a finished run gave back", async () => {
    const base = await mountBase();
    expect(base).toBeDefined();
    expect(dirname(base ?? "")).toBe(join(scratch, "run", MOUNT_DIR));
    expect(basename(base ?? "")).toMatch(new RegExp(`^${MOUNT_BASE}\\d+$`));
    expect((await stat(base ?? "")).mode & 0o777).toBe(0o700);
    const [first, second] = await Promise.all([judgeRoot("judge-artifact-", true), judgeRoot("judge-artifact-", true)]);
    expect(new Set([slotOf(first ?? ""), slotOf(second ?? "")])).toEqual(new Set(["slot-0", "slot-1"]));
    expect((await stat(first ?? "")).mode & 0o777).toBe(0o700);
    await writeFile(join(first ?? "", "left"), "old");
    expect(await removeCopy(first ?? "")).toBeUndefined();
    const third = await judgeRoot("judge-artifact-", true);
    expect(third).toBe(first);
    await expect(stat(join(third, "left"))).rejects.toThrow();
    await removeCopy(third);
    await removeCopy(second ?? "");
  });

  it("locks a slot with a file inside the private base, and a judge killed with SIGKILL gives its slot back", { timeout: 30_000 }, async () => {
    const base = (await mountBase()) ?? "";
    const killed = await judging();
    expect(killed.root).toBe(join(base, "slot-0"));
    expect(dirname(slotLock(base, 0))).toBe(base);
    const taken = await judgeRoot("judge-artifact-", true);
    expect(slotOf(taken)).toBe("slot-1");
    await removeCopy(taken);
    const ended = new Promise((done) => killed.child.once("exit", done));
    killed.child.kill("SIGKILL");
    await ended;
    const back = await takenAgain();
    expect(slotOf(back)).toBe("slot-0");
    await removeCopy(back);
  });

  it("keeps its slot locked through a Ctrl-C to the judge's process group until the judge's cleanup ends", { timeout: 30_000 }, async () => {
    const base = (await mountBase()) ?? "";
    const judge = await judging();
    const pid = judge.child.pid ?? 0;
    const holder = holderOf(pid) ?? 0;
    expect(holder).toBeGreaterThan(0);
    const groups = [groupOf(holder), groupOf(pid)];
    const free = () => spawnSync("flock", ["-n", slotLock(base, 0), "true"]).status === 0;
    const ended = new Promise((done) => judge.child.once("exit", done));
    process.kill(-pid, "SIGINT");
    await until(() => judge.lines.includes("interrupted"));
    expect(judge.lines).toEqual([join(base, "slot-0"), "interrupted"]);
    expect([alive(holder), free()]).toEqual([true, false]);
    await ended;
    expect(judge.lines.at(-1)).toBe("cleaned");
    await until(() => !alive(holder));
    expect([alive(holder), free()]).toEqual([false, true]);
    expect(groups[0]).not.toBe(groups[1]);
  });

  it("falls back to a fresh directory, and says so, when every slot is held", { timeout: 30_000 }, async () => {
    const base = (await mountBase()) ?? "";
    const holding = `for i in $(seq 0 ${MOUNT_SLOTS - 1}); do exec {fd}> "${base}/slot-$i.lock"; flock -n "$fd" || exit 3; done; echo held; exec sleep 600`;
    await started(spawn("bash", ["-c", holding], { stdio: ["ignore", "pipe", "inherit"], detached: true }));
    const { value: fresh, written } = await warnings(() => judgeRoot("judge-artifact-", true));
    expect(dirname(fresh)).toBe(scratch);
    expect(basename(fresh)).toMatch(/^judge-artifact-/);
    expect(written).toBe(`${MOUNT_FALLBACK}\n`);
    await removeCopy(fresh);
  });

  it("wipes what a killed judge left in a slot, hidden and read-only entries included, without following a symlink out of it", async () => {
    const base = (await mountBase()) ?? "";
    const outside = await planted(join(base, "slot-0"), join(scratch, "outside"));
    const artifact = join(scratch, "answer.txt");
    await writeFile(artifact, "42\n");
    const copy = await copyOf(await readArtifact(artifact), new TextEncoder().encode("spec\n"), undefined, true);
    expect(slotOf(copy.root)).toBe("slot-0");
    expect((await readdir(copy.root)).sort()).toEqual(["spec", "work"]);
    expect(await readdir(join(copy.root, "work"))).toEqual(["answer.txt"]);
    expect(await readFile(join(outside, "kept"), "utf8")).toBe("outside");
    expect((await stat(join(outside, "kept"))).mode & 0o777).toBe(0o444);
    expect((await stat(outside)).mode & 0o777).toBe(OUTSIDE_MODE);
    await removeCopy(copy.root);
    await planted(join(base, "slot-0"), outside);
    const root = await judgeRoot("judge-node-", true);
    expect([slotOf(root), await readdir(root)]).toEqual(["slot-0", []]);
    expect(await readFile(join(outside, "kept"), "utf8")).toBe("outside");
    expect((await stat(outside)).mode & 0o777).toBe(OUTSIDE_MODE);
    await removeCopy(root);
  });

  it("keeps fresh directories for runs that mount nothing, and warns when a mounted run finds no private slot base", async () => {
    const unmounted = await warnings(() => judgeRoot("judge-artifact-", false));
    expect([dirname(unmounted.value), unmounted.written]).toEqual([scratch, ""]);
    expect(basename(unmounted.value)).toMatch(/^judge-artifact-/);
    await removeCopy(unmounted.value);
    const run = join(scratch, "run");
    const home = join(scratch, "home");
    const inRun = (await mountBase()) ?? "";
    expect(dirname(dirname(inRun))).toBe(run);
    const inHome = join(home, ".cache", MOUNT_DIR, basename(inRun));
    for (const refused of [
      () => chmod(inRun, 0o750),
      () => chmod(dirname(inRun), 0o770),
      () => chmod(run, 0o750),
      async () => {
        await rm(dirname(inRun), { recursive: true });
        await mkdir(join(scratch, "elsewhere"), { mode: 0o700, recursive: true });
        await symlink(join(scratch, "elsewhere"), dirname(inRun));
      },
    ]) {
      spawnSync("chmod", ["-R", "u+rwX", run]);
      await rm(run, { recursive: true, force: true });
      await rm(join(scratch, "elsewhere"), { recursive: true, force: true });
      await mkdir(run, { mode: 0o700 });
      expect(await mountBase()).toBe(inRun);
      await refused();
      expect(await mountBase()).toBe(inHome);
    }
    delete process.env["XDG_RUNTIME_DIR"];
    expect(await mountBase()).toBe(inHome);
    expect((await stat(inHome)).mode & 0o777).toBe(0o700);
    await chmod(join(home, ".cache"), 0o775);
    expect(await mountBase()).toBeUndefined();
    const shared = await warnings(() => judgeRoot("judge-node-", true));
    expect([dirname(shared.value), shared.written]).toEqual([scratch, `${MOUNT_FALLBACK}\n`]);
    await chmod(join(home, ".cache"), 0o700);
    await chmod(home, 0o777);
    const open = await warnings(() => judgeRoot("judge-node-", true));
    expect([basename(open.value).startsWith("judge-node-"), open.written]).toEqual([true, `${MOUNT_FALLBACK}\n`]);
  });

  it("copies the artifact into a slot only for a mounted run, and removing the copy frees the slot", async () => {
    const artifact = join(scratch, "answer.txt");
    await writeFile(artifact, "42\n");
    const read = await readArtifact(artifact);
    const mounted = await copyOf(read, new TextEncoder().encode("spec\n"), undefined, true);
    expect(slotOf(mounted.root)).toBe("slot-0");
    expect(await readFile(mounted.path, "utf8")).toBe("42\n");
    const plain = await copyOf(read, new TextEncoder().encode("spec\n"));
    expect(basename(plain.root)).toMatch(/^judge-artifact-/);
    await removeCopy(plain.root);
    await removeCopy(mounted.root);
    const again = await copyOf(read, new TextEncoder().encode("spec\n"), undefined, true);
    expect(again.root).toBe(mounted.root);
    await removeCopy(again.root);
  });
});

describe("the host mount count", () => {
  const line = (point: string) => `1 2 0:1 / ${point} rw - ext4 /dev/sdd rw`;

  it("counts the namespace's mounts, or Docker Desktop's copies of its bind mounts when those are more, and warns near the limit", () => {
    expect(mountsOf([line("/"), line("/tmp"), ""].join("\n"), 100)).toEqual({ count: 2, limit: 100 });
    const binds = Array.from({ length: 20 }, (_, at) => line(`${DESKTOP_BIND_MOUNTS}solive/${at}`));
    expect(mountsOf([line("/"), ...binds].join("\n"), 100)).toEqual({ count: 20 * DESKTOP_COPIES, limit: 100 });
    expect(mountsNear({ count: 100 * MOUNTS_NEAR - 1, limit: 100 })).toBeUndefined();
    expect(mountsNear({ count: 100 * MOUNTS_NEAR, limit: 100 })).toContain("no space left on device");
    expect(mountsNear({ count: 99_968, limit: 100_000 })).toBe(
      "warning: the Docker host holds about 99968 of the 100000 mounts one mount namespace may hold; at the limit every docker run fails with no space left on device",
    );
  });

  it("reads the live count and limit on Linux", { skip: process.platform !== "linux" }, async () => {
    const found = await hostMounts();
    expect(found?.limit).toBe(Number((await readFile("/proc/sys/fs/mount-max", "utf8")).trim()));
    expect(found?.count).toBeGreaterThan(0);
  });
});
