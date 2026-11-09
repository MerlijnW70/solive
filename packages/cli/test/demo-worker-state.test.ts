import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { worker } from "./demo-worker-module.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const { emptyLedger, readLedger, resetBreaker, writeLedger } = worker;

const temp: string[] = [];
afterAll(async () => {
  await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "demo-state-"));
  temp.push(dir);
  return dir;
};

const holding = () => {
  const ledger = emptyLedger(["done-1"]);
  ledger.holds.set("held", { intent: "held", demo: "fizzbuzz", owner: "Owner", nonce: "1", stake: "10", killFee: "0", until: 1, reviewUntil: null, delivered: true, tries: 0, nextTry: 0 });
  return ledger;
};

describe("the demo worker's state file", () => {
  for (const [name, bytes] of [
    ["NUL bytes", Buffer.alloc(64)],
    ["nothing", Buffer.alloc(0)],
    ["a claim it cannot read", Buffer.from(JSON.stringify({ done: [], holds: [{ intent: "x" }] }))],
  ] as const) {
    it(`falls back to the last good copy when the file holds ${name}, and keeps the bad file beside it`, async () => {
      const dir = await scratch();
      const path = join(dir, "state.json");
      await writeLedger(path, holding());
      await writeLedger(path, holding());
      await writeFile(path, bytes);
      const read = await readLedger(path);
      expect(read.recovered).toBe("backup");
      expect([...read.holds.keys()]).toEqual(["held"]);
      expect([...read.done]).toEqual(["done-1"]);
      expect((await readdir(dir)).filter((file) => file.startsWith("state.json.corrupt-"))).toHaveLength(1);
    });
  }

  it("starts empty and reads its claims back from the chain when the file and its copy are both unreadable", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    await writeFile(path, Buffer.alloc(64));
    await writeFile(`${path}.bak`, "");
    const read = await readLedger(path);
    expect(read.recovered).toBe("rebuild");
    expect(read.holds.size).toBe(0);
    expect(read.done.size).toBe(0);
    expect((await readLedger(join(dir, "absent.json"))).recovered).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("refuses to start when the file cannot be read at all, since nothing could rebuild it safely", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    await writeLedger(path, holding());
    await chmod(path, 0o000);
    await expect(readLedger(path)).rejects.toThrow(/EACCES/);
    await chmod(path, 0o600);
  });

  it("stays readable under 20 concurrent writers, each with its own temporary file, and leaves no temporary file", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    const big = holding();
    for (let at = 0; at < 3000; at += 1) {
      big.done.add(`A-${"x".repeat(200)}-${at}`);
    }
    const small = holding();
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, at) => writeLedger(path, at % 2 === 0 ? big : small)));
    expect(results.map(({ status }) => status)).toEqual(Array.from({ length: 20 }, () => "fulfilled"));
    const read = await readLedger(path);
    expect(read.recovered).toBeNull();
    expect([...read.holds.keys()]).toEqual(["held"]);
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps strikes across a restart and clears them on --reset-breaker", async () => {
    const dir = await scratch();
    const path = join(dir, "state.json");
    const ledger = holding();
    ledger.strikes = [{ at: 5, owner: "Owner", kind: "failed", lamports: "0" }];
    ledger.openDeliveries = 4;
    await writeLedger(path, ledger);
    const read = await readLedger(path);
    expect(read.strikes).toEqual(ledger.strikes);
    expect(read.openDeliveries).toBe(4);
    expect(await resetBreaker(path)).toBe(1);
    expect((await readLedger(path)).strikes).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8")).holds).toHaveLength(1);
  });
});

describe("the demo worker's single instance", () => {
  it("refuses to start while another worker holds the lock beside the state file, before it runs anything", async () => {
    const dir = await scratch();
    const state = join(dir, "state.json");
    const holder = spawn("flock", ["-n", "-o", `${state}.lock`, "sleep", "30"], { stdio: "ignore" });
    try {
      await new Promise((done) => setTimeout(done, 500));
      const env = { ...process.env, DEMO_WORKER_KEYPAIR: join(dir, "key.json"), DEMO_WORKER_STATE: state, DEMO_WORKER_CLI: "/bin/false" };
      const run = spawnSync("bash", [join(ROOT, "scripts", "demo-worker.sh"), "--once"], { env, encoding: "utf8" });
      expect(run.status).toBe(75);
      expect(run.stderr).toContain(`another demo worker holds ${state}.lock, so this one does not start`);
    } finally {
      holder.kill();
    }
  });
});
