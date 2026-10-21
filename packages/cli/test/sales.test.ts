import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { link, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_ATTEMPTS,
  BUSY_BACKOFF_CAP_MS,
  BUSY_BACKOFF_MS,
  fileSales,
  LEFTOVER_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  type Sale,
  salesPath,
  WALLET_BUSY,
} from "../src/agent/sales.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;

const sale = (n: number): Sale => ({ id: `sale-${n}`, mint: MINT, at: BigInt(n), amount: BigInt(n) });

const appended = (s: Sale) => (sales: Sale[]) => ({ sales: [...sales, s], value: undefined });

const aged = (path: string, ms: number) => {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
};

const PATIENT_MS = 10 * 60 * 1000;

const WHOLE_SECOND_MS = 1_700_000_000_000;

const stamped = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);

const onPlatform = async (platform: string, work: () => Promise<void>) => {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    await work();
  } finally {
    if (real !== undefined) {
      Object.defineProperty(process, "platform", real);
    }
  }
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

  it("sales tests use an injected lock wait", async () => {
    expect(LOCK_WAIT_MS).toBe(5_000);
    writeFileSync(`${book}.lock`, "someone-else");
    const hasty = fileSales(undefined, undefined, 0);
    await expect(hasty.update(book, appended(sale(1)))).rejects.toMatchObject({ problem: { code: "WalletBusy", hint: WALLET_BUSY } });
    expect(readFileSync(`${book}.lock`, "utf8")).toBe("someone-else");
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json.lock"]);
    const patient = fileSales(undefined, undefined, PATIENT_MS);
    const waiting = patient.update(book, appended(sale(2)));
    rmSync(`${book}.lock`);
    await waiting;
    expect(await patient.read(book)).toEqual([sale(2)]);
  });

  it("a stale lock taken over by two writers loses no sale", async () => {
    const sales = fileSales(undefined, undefined, PATIENT_MS);
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
    const sales = fileSales(undefined, undefined, PATIENT_MS);
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

  it("the sales lock works where hard links fail", async () => {
    let links = 0;
    let lockSeen = "";
    const sales = fileSales(undefined, {
      rename,
      link: async () => {
        links++;
        throw failing("EPERM");
      },
    });
    await sales.update(book, (current) => {
      lockSeen = existsSync(`${book}.lock`) ? readFileSync(`${book}.lock`, "utf8") : "";
      return { sales: [...current, sale(1)], value: undefined };
    });
    expect(links).toBeGreaterThan(0);
    expect(lockSeen).not.toBe("");
    const before = links;
    await sales.update(book, appended(sale(2)));
    expect(links).toBe(before);
    expect(await sales.read(book)).toEqual([sale(1), sale(2)]);
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  it("two writers stay serialized without hard links", async () => {
    let active = 0;
    let overlapped = false;
    const files = {
      rename: async (from: string, to: string) => {
        active++;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await rename(from, to);
        active--;
      },
      link: async () => {
        throw failing("EPERM");
      },
    };
    const first = fileSales(undefined, files, PATIENT_MS);
    const second = fileSales(undefined, files, PATIENT_MS);
    const writers = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? first : second).update(book, appended(sale(i))));
    await Promise.all(writers);
    expect(overlapped).toBe(false);
    expect((await first.read(book)).map((s) => s.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `sale-${i}`).sort());
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a link error that is not about links fails the sale on Linux but falls back to plain files on Windows", async () => {
    const broken = (code: string) => ({
      rename,
      link: async () => {
        throw failing(code);
      },
    });
    await onPlatform("linux", async () => {
      await expect(fileSales(undefined, broken("EIO"), 0).update(book, appended(sale(1)))).rejects.toMatchObject({ code: "EIO" });
      expect(readdirSync(root)).toEqual([]);
    });
    const windows = join(root, "windows");
    await onPlatform("win32", async () => {
      const sales = fileSales((path) => join(windows, path), broken("EIO"), 0);
      await sales.update("book.json", appended(sale(2)));
      expect(await sales.read("book.json")).toEqual([sale(2)]);
      await expect(fileSales((path) => join(root, "busy", path), broken("EBUSY"), 0).update("book.json", appended(sale(3)))).rejects.toMatchObject({
        problem: { code: "WalletBusy" },
      });
    });
  });

  it("a link refused only for the lock is a busy lock, not a folder without links", async () => {
    const files = {
      rename,
      link: async (existing: string, path: string) => {
        if (path === `${book}.lock`) {
          throw failing("EPERM");
        }
        await link(existing, path);
      },
    };
    await expect(fileSales(undefined, files, 0).update(book, appended(sale(1)))).rejects.toMatchObject({ problem: { code: "WalletBusy" } });
    expect(readdirSync(root)).toEqual([]);
  });

  it("a busy rename backs off by doubling delays up to the cap", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const sales = fileSales(undefined, {
      rename: async () => {
        throw failing("EBUSY");
      },
    });
    await expect(sales.update(book, appended(sale(1)))).rejects.toMatchObject({ code: "EBUSY" });
    const delays = timers.mock.calls.map((args) => args[1]);
    expect(delays).toEqual(
      Array.from({ length: BUSY_ATTEMPTS - 1 }, (_, i) => Math.min(BUSY_BACKOFF_MS * 2 ** i, BUSY_BACKOFF_CAP_MS)),
    );
    expect(delays.slice(0, 5)).toEqual([10, 20, 40, 80, 160]);
  });

  it("the sweep removes only this book's temporary files, and only once they are older than a minute", async () => {
    vi.spyOn(Date, "now").mockReturnValue(WHOLE_SECOND_MS + LEFTOVER_MS);
    const edge = `${book}.edge.tmp`;
    const older = `${book}.older.tmp`;
    const foreign = join(root, "other.tmp");
    const notes = `${book}.notes`;
    for (const path of [edge, older, foreign, notes]) {
      writeFileSync(path, "[]");
      stamped(path, WHOLE_SECOND_MS);
    }
    for (const path of [older, foreign, notes]) {
      stamped(path, WHOLE_SECOND_MS - 1_000);
    }
    await fileSales().update(book, appended(sale(1)));
    expect(readdirSync(root).sort()).toEqual(["other.tmp", "wallet.json.sales.json", "wallet.json.sales.json.edge.tmp", "wallet.json.sales.json.notes"]);
  });

  it("a lock is stale only once it is older than the stale age", async () => {
    vi.spyOn(Date, "now").mockReturnValue(WHOLE_SECOND_MS + LOCK_STALE_MS);
    writeFileSync(`${book}.lock`, "someone-else");
    stamped(`${book}.lock`, WHOLE_SECOND_MS);
    await expect(fileSales(undefined, undefined, 0).update(book, appended(sale(1)))).rejects.toMatchObject({ problem: { code: "WalletBusy" } });
    expect(readFileSync(`${book}.lock`, "utf8")).toBe("someone-else");
    stamped(`${book}.lock`, WHOLE_SECOND_MS - 1_000);
    await fileSales(undefined, undefined, 0).update(book, appended(sale(2)));
    expect(await fileSales().read(book)).toEqual([sale(2)]);
    expect(readdirSync(root).sort()).toEqual(["wallet.json.sales.json"]);
  });

  it("a lock wait gives up once the deadline is reached, even while the clock stands still", async () => {
    vi.spyOn(Date, "now").mockReturnValue(WHOLE_SECOND_MS);
    writeFileSync(`${book}.lock`, "someone-else");
    stamped(`${book}.lock`, WHOLE_SECOND_MS);
    const outcome = fileSales(undefined, undefined, 0)
      .update(book, appended(sale(1)))
      .then(
        () => "saved",
        (error: { problem?: { code?: string } }) => error.problem?.code,
      );
    setTimeout(() => rmSync(`${book}.lock`, { force: true }), 200);
    expect(await outcome).toBe("WalletBusy");
  });
});
