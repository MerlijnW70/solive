import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Address } from "@solana/kit";
import { AgentRefusal } from "./problems.js";

export type Sale = { id: string; mint: Address; at: bigint; amount: bigint };

export type SaleBook = {
  read(path: string): Promise<Sale[]>;
  update<T>(path: string, change: (sales: Sale[]) => { sales: Sale[]; value: T }): Promise<T>;
};

export type SaleFiles = {
  rename(from: string, to: string): Promise<void>;
  link?(existing: string, path: string): Promise<void>;
};

type Linker = (existing: string, path: string) => Promise<void>;

export const LOCK_WAIT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_POLL_MS = 20;
export const BUSY_ATTEMPTS = 10;
export const BUSY_BACKOFF_MS = 10;
export const BUSY_BACKOFF_CAP_MS = 200;
export const LEFTOVER_MS = 60_000;

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

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

const missing = (error: unknown): boolean => codeOf(error) === "ENOENT";

const taken = (error: unknown): boolean => codeOf(error) === "EEXIST";

const BUSY_CODES: ReadonlySet<unknown> = new Set(["EPERM", "EACCES", "EBUSY"]);

const busy = (error: unknown): boolean => BUSY_CODES.has(codeOf(error));

const UNLINKABLE_CODES: ReadonlySet<unknown> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

const unlinkable = (error: unknown): boolean =>
  UNLINKABLE_CODES.has(codeOf(error)) || (process.platform === "win32" && !taken(error) && !busy(error));

const linkless = new Set<string>();

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function retried<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!busy(error) || attempt >= BUSY_ATTEMPTS) {
        throw error;
      }
      await pause(Math.min(BUSY_BACKOFF_MS * 2 ** (attempt - 1), BUSY_BACKOFF_CAP_MS));
    }
  }
}

async function readSales(file: string, path: string): Promise<Sale[]> {
  try {
    return parsed(await retried(() => readFile(file, "utf8")), path);
  } catch (error) {
    if (missing(error)) {
      return [];
    }
    throw error;
  }
}

async function written(file: string, text: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(file).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function sweep(file: string): Promise<void> {
  const folder = dirname(file);
  const prefix = `${basename(file)}.`;
  const names = await readdir(folder).catch(() => [] as string[]);
  const cutoff = Date.now() - LEFTOVER_MS;
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
      .map(async (name) => {
        const leftover = join(folder, name);
        const seen = await stat(leftover).catch(() => null);
        if (seen !== null && seen.mtimeMs < cutoff) {
          await rm(leftover).catch(() => undefined);
        }
      }),
  );
}

async function writeSales(file: string, sales: Sale[], files: SaleFiles): Promise<void> {
  await sweep(file);
  const rows: Stored[] = sales.map((s) => ({ id: s.id, mint: s.mint, at: s.at.toString(), amount: s.amount.toString() }));
  const temporary = `${file}.${randomUUID()}.tmp`;
  await written(temporary, JSON.stringify(rows));
  try {
    await retried(() => files.rename(temporary, file));
  } catch (error) {
    await rm(temporary).catch(() => undefined);
    throw error;
  }
}

async function ownerOf(lock: string): Promise<string | null> {
  try {
    return await retried(() => readFile(lock, "utf8"));
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
}

async function linksFail(linker: Linker, temporary: string, lock: string): Promise<boolean> {
  const probe = `${lock}.${randomUUID()}.tmp`;
  try {
    await linker(temporary, probe);
  } catch {
    return true;
  }
  await rm(probe).catch(() => undefined);
  return false;
}

async function created(lock: string, token: string): Promise<void> {
  try {
    await written(lock, token);
  } catch (error) {
    if (!taken(error) && !busy(error)) {
      throw error;
    }
  }
}

async function linked(lock: string, token: string, linker: Linker): Promise<void> {
  const temporary = `${lock}.${randomUUID()}.tmp`;
  await written(temporary, token);
  try {
    await linker(temporary, lock);
  } catch (error) {
    if (unlinkable(error) && (await linksFail(linker, temporary, lock))) {
      linkless.add(dirname(lock));
    } else if (!taken(error) && !busy(error)) {
      throw error;
    }
  } finally {
    await rm(temporary).catch(() => undefined);
  }
}

async function claim(lock: string, token: string, linker: Linker): Promise<boolean> {
  const folder = dirname(lock);
  if (!linkless.has(folder)) {
    await linked(lock, token, linker);
  }
  if (linkless.has(folder)) {
    await created(lock, token);
  }
  return (await ownerOf(lock)) === token;
}

async function release(lock: string, token: string): Promise<void> {
  if ((await ownerOf(lock)) === token) {
    await retried(() => rm(lock));
  }
}

const stale = async (path: string): Promise<boolean> => {
  const seen = await stat(path).catch(() => null);
  return seen !== null && Date.now() - seen.mtimeMs > LOCK_STALE_MS;
};

async function takeOver(lock: string, token: string, linker: Linker): Promise<boolean> {
  const old = await ownerOf(lock);
  if (old === null) {
    return false;
  }
  const breaker = `${lock}.break`;
  if (!(await claim(breaker, token, linker))) {
    if (await stale(breaker)) {
      await rm(breaker, { force: true });
    }
    return false;
  }
  try {
    if ((await ownerOf(lock)) !== old || !(await stale(lock))) {
      return false;
    }
    await retried(() => rm(lock, { force: true }));
    return await claim(lock, token, linker);
  } finally {
    await release(breaker, token).catch(() => undefined);
  }
}

async function locked<T>(file: string, linker: Linker, waitMs: number, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const token = randomUUID();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await claim(lock, token, linker)) {
      break;
    }
    if ((await stale(lock)) && (await takeOver(lock, token, linker))) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new AgentRefusal("WalletBusy", WALLET_BUSY);
    }
    await pause(LOCK_POLL_MS);
  }
  try {
    return await work();
  } finally {
    await release(lock, token).catch(() => undefined);
  }
}

export function fileSales(locate: (path: string) => string = (path) => path, files: SaleFiles = { rename }, waitMs = LOCK_WAIT_MS): SaleBook {
  const linker: Linker = files.link === undefined ? link : files.link.bind(files);
  return {
    read: (path) => readSales(locate(path), path),
    update: (path, change) => {
      const file = locate(path);
      return locked(file, linker, waitMs, async () => {
        const { sales, value } = change(await readSales(file, path));
        await writeSales(file, sales, files);
        return value;
      });
    },
  };
}
