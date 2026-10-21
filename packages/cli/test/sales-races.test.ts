import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileSales, LOCK_STALE_MS, type Sale, salesPath } from "../src/agent/sales.js";

const races = vi.hoisted(() => ({ afterStat: (_path: string, _count: number): void => undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const counts = new Map<string, number>();
  return {
    ...actual,
    stat: async (path: string) => {
      const seen = await actual.stat(path);
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      races.afterStat(path, count);
      return seen;
    },
  };
});

const MINT = "So11111111111111111111111111111111111111112" as Address;

const sale = (n: number): Sale => ({ id: `sale-${n}`, mint: MINT, at: BigInt(n), amount: BigInt(n) });

const PATIENT_MS = 10 * 60 * 1000;

const aged = (path: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
};

describe("taking over a stale sales lock while other writers move", () => {
  let root: string;
  let book: string;
  let lock: string;
  let lockSeen: string;

  const watched = (sales: Sale[]) => {
    lockSeen = existsSync(lock) ? readFileSync(lock, "utf8") : "";
    return { sales: [...sales, sale(1)], value: undefined };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "solive-races-"));
    book = salesPath(join(root, "wallet.json"));
    lock = `${book}.lock`;
    lockSeen = "";
    writeFileSync(lock, "crashed");
    aged(lock, LOCK_STALE_MS * 2);
  });

  afterEach(() => {
    races.afterStat = () => undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("a stale lock that vanishes before its owner is read is claimed afresh, never skipped", async () => {
    races.afterStat = (path, count) => {
      if (path === lock && count === 1) {
        rmSync(lock);
      }
    };
    await fileSales(undefined, undefined, PATIENT_MS).update(book, watched);
    expect(lockSeen).not.toBe("");
    expect(lockSeen).not.toBe("crashed");
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  it("a stale breaker that another writer removes first does not fail the sale", async () => {
    const breaker = `${lock}.break`;
    writeFileSync(breaker, "other");
    aged(breaker, LOCK_STALE_MS * 2);
    races.afterStat = (path, count) => {
      if (path === breaker && count === 1) {
        rmSync(breaker);
      }
    };
    await fileSales(undefined, undefined, PATIENT_MS).update(book, watched);
    expect(lockSeen).not.toBe("crashed");
    expect(await fileSales().read(book)).toEqual([sale(1)]);
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  it("a lock its owner refreshes during the takeover is left alone", async () => {
    races.afterStat = (path, count) => {
      if (path === lock && count === 1) {
        const now = new Date();
        utimesSync(lock, now, now);
      }
    };
    await expect(fileSales(undefined, undefined, 0).update(book, watched)).rejects.toMatchObject({ problem: { code: "WalletBusy" } });
    expect(lockSeen).toBe("");
    expect(readFileSync(lock, "utf8")).toBe("crashed");
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json.lock"]);
  });

  it("a stale lock that vanishes just before the takeover removes it is still claimed", async () => {
    races.afterStat = (path, count) => {
      if (path === lock && count === 2) {
        rmSync(lock);
      }
    };
    await fileSales(undefined, undefined, PATIENT_MS).update(book, watched);
    expect(lockSeen).not.toBe("");
    expect(lockSeen).not.toBe("crashed");
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });
});
