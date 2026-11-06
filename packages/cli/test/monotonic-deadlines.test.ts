import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@intent-engine/client";
import type { IntentChanges } from "@intent-engine/client/internal";
import { rentRate, RENT_TTL_MS } from "../src/agent/budget.js";
import { waitForJobs } from "../src/agent/job-wait.js";
import { fileSales, LOCK_STALE_MS, type Sale, salesPath } from "../src/agent/sales.js";
import { nodeRuntime } from "../src/main.js";
import { elapsedOf, monotonic, secondsLeft } from "../src/monotonic.js";

const DAY_MS = 86_400_000;

const MINT = "So11111111111111111111111111111111111111112" as Address;

function steppingWall(ahead = DAY_MS): () => void {
  const real = Date.now.bind(Date);
  let calls = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    calls += 1;
    return real() + (calls % 2 === 0 ? ahead : -DAY_MS);
  });
  return () => spy.mockRestore();
}

function rentServing() {
  const reads = { count: 0 };
  const data = new Uint8Array(17);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 3_480n, true);
  view.setFloat64(8, 2, true);
  const transport = {
    getAccount: async () => {
      reads.count += 1;
      return { owner: "Sysvar1111111111111111111111111111111111111" as Address, data, lamports: 1n };
    },
  } as unknown as Transport;
  return { transport, reads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the production clock for waits", () => {
  it("reads performance.now, never the wall clock, in the runtime and by default", () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    const mono = vi.spyOn(performance, "now").mockReturnValue(1_234);
    expect(nodeRuntime().elapsed).toBe(monotonic);
    expect(monotonic()).toBe(1_234);
    expect(elapsedOf({})).toBe(1_234);
    const left = secondsLeft(10);
    mono.mockReturnValue(5_234);
    wall.mockReturnValue(DAY_MS);
    expect(left()).toBe(6);
    expect(wall).not.toHaveBeenCalled();
  });
});

describe("a deadline that starts and ends in one process", () => {
  it("counts down by elapsed time while the wall clock steps back and forward", () => {
    const restore = steppingWall();
    let at = 0;
    const left = secondsLeft(30, () => at);
    expect(left()).toBe(30);
    at = 10_000;
    expect(left()).toBe(20);
    at = 29_500;
    expect(left()).toBe(0.5);
    at = 31_000;
    expect(left()).toBe(0);
    restore();
  });

  it("keeps the rent rate for its lifetime by elapsed time", async () => {
    const restore = steppingWall();
    const { transport, reads } = rentServing();
    let at = 0;
    const elapsed = () => at;
    await rentRate(transport, elapsed);
    await rentRate(transport, elapsed);
    expect(reads.count).toBe(1);
    at = RENT_TTL_MS - 1;
    await rentRate(transport, elapsed);
    expect(reads.count).toBe(1);
    at = RENT_TTL_MS;
    await rentRate(transport, elapsed);
    expect(reads.count).toBe(2);
    restore();
  });

  it("gives up on a held sales lock once its wait has elapsed, whatever the wall clock does", async () => {
    const root = mkdtempSync(join(tmpdir(), "solive-book-"));
    const book = salesPath(join(root, "wallet.json"));
    const sale: Sale = { id: "sale-1", mint: MINT, at: 1n, amount: 1n };
    const polls = async (stepping: boolean) => {
      writeFileSync(`${book}.lock`, "someone-else");
      let at = 0;
      let reads = 0;
      const restore = stepping ? steppingWall(LOCK_STALE_MS / 2) : () => undefined;
      const elapsed = () => {
        reads += 1;
        at += 20;
        return at;
      };
      await expect(fileSales(undefined, undefined, 200, elapsed).update(book, (sales) => ({ sales: [...sales, sale], value: undefined }))).rejects.toMatchObject({
        problem: { code: "WalletBusy" },
      });
      restore();
      return reads;
    };
    try {
      const steady = await polls(false);
      expect(steady).toBeGreaterThan(1);
      expect(await polls(true)).toBe(steady);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts the time a job notification took by elapsed time", async () => {
    const noted = [{ address: "11111111111111111111111111111112" as Address, data: new Uint8Array() }];
    const waited = async (first: bigint) => {
      let at = 0;
      let wall = 0n;
      let calls = 0;
      const sleeps: number[] = [];
      const clock = {
        now: () => wall,
        elapsed: () => at,
        sleep: async (seconds: number) => {
          sleeps.push(seconds);
          at += seconds * 1_000;
          return true;
        },
      };
      const changes: IntentChanges = {
        wait: async () => {
          calls += 1;
          at += 1_000;
          wall += calls === 1 ? first : -first;
          return calls === 1 ? noted : [];
        },
        close: () => undefined,
      };
      return { total: await waitForJobs(clock, 10, async () => false, changes), sleeps };
    };
    for (const step of [0n, -86_400n, 172_800n]) {
      expect(await waited(step)).toEqual({ total: 10, sleeps: [1] });
    }
  });
});
