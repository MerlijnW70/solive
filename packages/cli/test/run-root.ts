import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const RUN_ROOT_PREFIX = "solive-run-";
export const OWNER_FILE = ".owner";
export const SCRATCH_DIR = "t";
const ROOT_NAME = /^solive-run-(\d+)-[A-Za-z0-9]{6}$/;
const STAT_FIELD_AFTER_NAME = 19;
const RETRIES = 3;
const TRAVERSABLE = 0o711;
const SHARED = 0o1777;

export function startOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[STAT_FIELD_AFTER_NAME] ?? "";
  } catch {
    return "";
  }
}

export function aliveAt(pid: number, started: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return started === "" || startOf(pid) === started;
}

export function claimRoot(base: string, pid = process.pid): string {
  const root = mkdtempSync(join(base, `${RUN_ROOT_PREFIX}${pid}-`));
  writeFileSync(join(root, OWNER_FILE), JSON.stringify({ pid, started: startOf(pid) }), { flag: "wx", mode: 0o600 });
  chmodSync(root, TRAVERSABLE);
  const scratch = join(root, SCRATCH_DIR);
  mkdirSync(scratch);
  chmodSync(scratch, SHARED);
  return root;
}

function ownedRoot(base: string, root: string): boolean {
  if (base === "" || dirname(root) !== base || !ROOT_NAME.test(basename(root))) {
    return false;
  }
  const found = lstatSync(root, { throwIfNoEntry: false });
  return found !== undefined && found.isDirectory() && (process.getuid === undefined || found.uid === process.getuid());
}

function recordedStart(root: string, pid: number): string | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(root, OWNER_FILE), "utf8")) as { pid?: unknown; started?: unknown };
    return owner.pid === pid && typeof owner.started === "string" ? owner.started : undefined;
  } catch {
    return undefined;
  }
}

function reopen(path: string): void {
  const found = lstatSync(path, { throwIfNoEntry: false });
  if (found === undefined || found.isSymbolicLink() || !found.isDirectory()) {
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    reopen(join(path, name));
  }
}

export function removeRoot(base: string, root: string): boolean {
  if (!ownedRoot(base, root)) {
    return false;
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: RETRIES });
  } catch {
    try {
      reopen(root);
      rmSync(root, { recursive: true, force: true, maxRetries: RETRIES });
    } catch {
      return false;
    }
  }
  return true;
}

export function sweepStale(base: string): string[] {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = ROOT_NAME.exec(name);
    if (match === null) {
      continue;
    }
    const root = join(base, name);
    const pid = Number(match[1]);
    if (!ownedRoot(base, root)) {
      continue;
    }
    const started = recordedStart(root, pid);
    if (started === undefined || aliveAt(pid, started)) {
      continue;
    }
    if (removeRoot(base, root)) {
      removed.push(root);
    }
  }
  return removed;
}
