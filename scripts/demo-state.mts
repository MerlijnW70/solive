import { randomBytes } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { record } from "./demo-chain.mts";

export type Hold = {
  intent: string;
  demo: string;
  owner: string;
  nonce: string;
  stake: string;
  killFee: string;
  until: number;
  reviewUntil: number | null;
  delivered: boolean;
  tries: number;
  nextTry: number;
};

export type StrikeKind = "lost" | "failed" | "unprotected";

export type Strike = { at: number; owner: string; kind: StrikeKind; lamports: string };

export type Recovery = "backup" | "rebuild" | null;

export type Ledger = {
  done: Set<string>;
  failures: Map<string, number>;
  noted: Set<string>;
  holds: Map<string, Hold>;
  lastDelivery: { at: number; intent: string } | null;
  collected: bigint;
  lost: bigint;
  strikes: Strike[];
  openDeliveries: number;
  recovered: Recovery;
};

export const emptyLedger = (done: Iterable<string> = []): Ledger => ({
  done: new Set(done),
  failures: new Map(),
  noted: new Set(),
  holds: new Map(),
  lastDelivery: null,
  collected: 0n,
  lost: 0n,
  strikes: [],
  openDeliveries: 0,
  recovered: null,
});

const wholeOf = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

const lamportsText = (value: unknown): string => (typeof value === "string" && /^\d+$/.test(value) ? value : "0");

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

class Unreadable extends Error {}

function holdFrom(value: unknown): Hold {
  const held = record(value);
  const text = (key: string) => {
    const found = held[key];
    if (typeof found !== "string" || found === "") {
      throw new Unreadable(`a claim without ${key}`);
    }
    return found;
  };
  const stake = text("stake");
  const killFee = text("killFee");
  if (!/^\d+$/.test(stake) || !/^\d+$/.test(killFee)) {
    throw new Unreadable("a claim whose stake or kill fee is not a whole number of lamports");
  }
  const reviewUntil = held["reviewUntil"] === null || held["reviewUntil"] === undefined ? null : wholeOf(held["reviewUntil"]);
  return {
    intent: text("intent"),
    demo: text("demo"),
    owner: text("owner"),
    nonce: text("nonce"),
    stake,
    killFee,
    until: wholeOf(held["until"]),
    reviewUntil,
    delivered: held["delivered"] === true,
    tries: wholeOf(held["tries"]),
    nextTry: wholeOf(held["nextTry"]),
  };
}

const KINDS: readonly StrikeKind[] = ["lost", "failed", "unprotected"];

function strikeFrom(value: unknown): Strike | null {
  const strike = record(value);
  const kind = KINDS.find((each) => each === strike["kind"]);
  return kind === undefined || typeof strike["owner"] !== "string" ? null : { at: wholeOf(strike["at"]), owner: strike["owner"], kind, lamports: lamportsText(strike["lamports"]) };
}

export function ledgerOf(text: string): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Unreadable("text that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>)["done"])) {
    throw new Unreadable("JSON that holds no list of done escrows");
  }
  const saved = record(parsed);
  const ledger = emptyLedger(strings(saved["done"]));
  for (const hold of Array.isArray(saved["holds"]) ? saved["holds"] : []) {
    const read = holdFrom(hold);
    ledger.holds.set(read.intent, read);
  }
  const last = record(saved["last_delivery"]);
  ledger.lastDelivery = typeof last["intent"] === "string" ? { at: wholeOf(last["at"]), intent: last["intent"] } : null;
  ledger.collected = BigInt(lamportsText(saved["collected_lamports"]));
  ledger.lost = BigInt(lamportsText(saved["lost_lamports"]));
  ledger.strikes = (Array.isArray(saved["strikes"]) ? saved["strikes"] : []).map(strikeFrom).filter((each): each is Strike => each !== null);
  ledger.openDeliveries = wholeOf(saved["open_deliveries"]);
  return ledger;
}

const textOfLedger = (ledger: Ledger): string =>
  `${JSON.stringify({
    done: [...ledger.done],
    holds: [...ledger.holds.values()],
    last_delivery: ledger.lastDelivery,
    collected_lamports: String(ledger.collected),
    lost_lamports: String(ledger.lost),
    strikes: ledger.strikes,
    open_deliveries: ledger.openDeliveries,
  })}\n`;

const codeOf = (error: unknown): unknown => record(error)["code"];

async function readOne(path: string): Promise<Ledger | "missing" | "corrupt"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  try {
    return ledgerOf(text);
  } catch (error) {
    if (error instanceof Unreadable) {
      return "corrupt";
    }
    throw error;
  }
}

export const backupOf = (path: string): string => `${path}.bak`;

export async function readLedger(path: string): Promise<Ledger> {
  const current = await readOne(path);
  if (typeof current === "object") {
    return current;
  }
  if (current === "corrupt") {
    await rename(path, `${path}.corrupt-${Date.now()}`);
  }
  const backup = await readOne(backupOf(path));
  if (typeof backup === "object") {
    backup.recovered = "backup";
    return backup;
  }
  if (current === "missing" && backup === "missing") {
    return emptyLedger();
  }
  const rebuilt = emptyLedger();
  rebuilt.recovered = "rebuild";
  return rebuilt;
}

async function syncDir(path: string): Promise<void> {
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    if (codeOf(error) !== "EISDIR" && codeOf(error) !== "EINVAL" && codeOf(error) !== "EPERM") {
      throw error;
    }
  }
}

export async function replaceFile(path: string, text: string, durable = true): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    if (durable) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  if (durable) {
    await syncDir(path);
  }
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  if (typeof (await readOne(path)) === "object") {
    await unlink(backupOf(path)).catch((error: unknown) => {
      if (codeOf(error) !== "ENOENT") {
        throw error;
      }
    });
    await link(path, backupOf(path)).catch((error: unknown) => {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
    });
  }
  await replaceFile(path, textOfLedger(ledger));
}
