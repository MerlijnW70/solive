import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUSY_ATTEMPTS, fileSales, LEFTOVER_MS, LOCK_STALE_MS, type Sale, salesPath } from "../src/agent/sales.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;

const sale = (n: number): Sale => ({ id: `sale-${n}`, mint: MINT, at: BigInt(n), amount: BigInt(n) });

const appended = (s: Sale) => (sales: Sale[]) => ({ sales: [...sales, s], value: undefined });

const aged = (path: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
};

const failing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe("the shared sales book", () => {
  let root: string;
  let book: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "solive-book-"));
    book = salesPath(join(root, "wallet.json"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a stale lock taken over by two writers loses no sale", async () => {
    const sales = fileSales();
    for (let round = 0; round < 5; round++) {
      writeFileSync(`${book}.lock`, `crashed-${round}`);
      aged(`${book}.lock`, LOCK_STALE_MS * 2);
      const writers = Array.from({ length: 8 }, (_, i) => sale(round * 8 + i));
      await Promise.all(writers.map((s) => sales.update(book, appended(s))));
      expect((await sales.read(book)).map((s) => s.id).sort()).toEqual(
        Array.from({ length: (round + 1) * 8 }, (_, i) => `sale-${i}`).sort(),
      );
      expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
    }
  });

  it("a lock held by another writer is left in place", async () => {
    const sales = fileSales();
    writeFileSync(`${book}.lock`, "someone-else");
    const waiting = sales.update(book, appended(sale(1)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(`${book}.lock`, "utf8")).toBe("someone-else");
    rmSync(`${book}.lock`);
    await waiting;
    expect(await sales.read(book)).toEqual([sale(1)]);
  });

  it("a busy rename is retried", async () => {
    const attempts: string[] = [];
    const codes = ["EPERM", "EACCES", "EBUSY"];
    const sales = fileSales(undefined, {
      rename: async (from, to) => {
        const code = codes.shift();
        attempts.push(code ?? "renamed");
        if (code !== undefined) {
          throw failing(code);
        }
        await rename(from, to);
      },
    });
    await sales.update(book, appended(sale(1)));
    expect(attempts).toEqual(["EPERM", "EACCES", "EBUSY", "renamed"]);
    expect(await sales.read(book)).toEqual([sale(1)]);
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  it("a rename that stays busy fails without leaving a temporary file or the lock", async () => {
    let attempts = 0;
    const sales = fileSales(undefined, {
      rename: async () => {
        attempts++;
        throw failing("EPERM");
      },
    });
    await expect(sales.update(book, appended(sale(1)))).rejects.toMatchObject({ code: "EPERM" });
    expect(attempts).toBe(BUSY_ATTEMPTS);
    expect(readdirSync(root)).toEqual([]);
  });

  it("leftover temporary files older than a minute are removed when the book is next saved", async () => {
    const sales = fileSales();
    const old = `${book}.crashed.tmp`;
    const fresh = `${book}.writing.tmp`;
    writeFileSync(old, "[]");
    writeFileSync(fresh, "[]");
    aged(old, LEFTOVER_MS * 2);
    await sales.update(book, appended(sale(1)));
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json", "wallet.json.sales.json.writing.tmp"]);
  });
});
