import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address } from "@solana/kit";
import { AgentRefusal } from "./problems.js";

export type Sale = { id: string; mint: Address; at: bigint; amount: bigint };

export type SaleBook = {
  read(path: string): Promise<Sale[]>;
  update<T>(path: string, change: (sales: Sale[]) => { sales: Sale[]; value: T }): Promise<T>;
};

export const LOCK_WAIT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_POLL_MS = 20;

export const salesPath = (keypair: string): string => `${keypair}.sales.json`;

export const salesBroken = (path: string): string =>
  `${path} is not a sale record this server wrote; delete it to reset the wallet's hourly count`;

export const WALLET_BUSY = "another server using this wallet is recording a sale right now; call again in a moment";

type Stored = { id: string; mint: string; at: string; amount: string };

function parsed(text: string, path: string): Sale[] {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(salesBroken(path));
  }
  if (!Array.isArray(rows)) {
    throw new Error(salesBroken(path));
  }
  return rows.map((row: Partial<Stored>) => {
    if (typeof row?.id !== "string" || typeof row.mint !== "string" || typeof row.at !== "string" || typeof row.amount !== "string") {
      throw new Error(salesBroken(path));
    }
    try {
      return { id: row.id, mint: row.mint as Address, at: BigInt(row.at), amount: BigInt(row.amount) };
    } catch {
      throw new Error(salesBroken(path));
    }
  });
}

const missing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

const taken = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "EEXIST";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readSales(file: string, path: string): Promise<Sale[]> {
  try {
    return parsed(await readFile(file, "utf8"), path);
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
}

async function writeSales(file: string, sales: Sale[]): Promise<void> {
  const rows: Stored[] = sales.map((s) => ({ id: s.id, mint: s.mint, at: s.at.toString(), amount: s.amount.toString() }));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(rows));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (!taken(error)) {
        throw error;
      }
    }
    const held = await stat(lock).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      await rm(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new AgentRefusal("WalletBusy", WALLET_BUSY);
    }
    await pause(LOCK_POLL_MS);
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

export function fileSales(locate: (path: string) => string = (path) => path): SaleBook {
  return {
    read: (path) => readSales(locate(path), path),
    update: (path, change) => {
      const file = locate(path);
      return locked(file, async () => {
        const { sales, value } = change(await readSales(file, path));
        await writeSales(file, sales);
        return value;
      });
    },
  };
}
