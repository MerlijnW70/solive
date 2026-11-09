import { readFile, rename, writeFile } from "node:fs/promises";
import { type Cli, type Event, record, sentSignature, textOf } from "./demo-chain.mts";

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

export type Ledger = {
  done: Set<string>;
  failures: Map<string, number>;
  noted: Set<string>;
  holds: Map<string, Hold>;
  lastDelivery: { at: number; intent: string } | null;
  collected: bigint;
  lost: bigint;
};

export type Caps = { maxStake: bigint; maxAtRisk: bigint; maxPerOwner: bigint; claimSecs: number };

export type Terms = { stake: bigint; killFee: bigint; reviewSecs: number; maxSecs: number };

export type Refusal = { reason: string; final: boolean };

export type Plan = { secs: number; terms: Terms };

export type Payer = { keypair: string; wallet: string };

export const CLAIM_MARGIN_SECS = 60;
export const MIN_CLAIM_SECS = 120;
export const OVERDUE_SECS = 3_600;
export const COLLECT_RETRY_SECS = 60;
export const MAX_COLLECT_RETRY_SECS = 3_600;
export const REVIEW_RECHECK_SECS = 1_800;

export const emptyLedger = (done: Iterable<string> = []): Ledger => ({ done: new Set(done), failures: new Map(), noted: new Set(), holds: new Map(), lastDelivery: null, collected: 0n, lost: 0n });

const wholeOf = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

const lamportsOf = (value: unknown, what: string): bigint => {
  const text = textOf(value) ?? "0";
  if (!/^\d+$/.test(text)) {
    throw new Error(`the claims board shows ${what} as ${JSON.stringify(value)}, not a whole number of lamports`);
  }
  return BigInt(text);
};

export const termsOf = (board: Record<string, unknown>): Terms => ({
  stake: lamportsOf(board["stake"], "the stake"),
  killFee: lamportsOf(board["kill_fee"], "the kill fee"),
  reviewSecs: wholeOf(board["review_secs"]),
  maxSecs: wholeOf(board["max_secs"]),
});

export const atRisk = (holds: Iterable<Hold>, owner?: string): bigint => {
  let total = 0n;
  for (const hold of holds) {
    total += owner === undefined || hold.owner === owner ? BigInt(hold.stake) : 0n;
  }
  return total;
};

export function claimPlan(terms: Terms, owner: string, expiresAt: number, now: number, caps: Caps, holds: readonly Hold[]): Plan | Refusal {
  if (terms.stake > caps.maxStake) {
    return { reason: `its claim stake of ${terms.stake} lamports is above this worker's cap of ${caps.maxStake}`, final: true };
  }
  if (terms.stake > 0n && terms.reviewSecs === 0) {
    return { reason: `its claims open no review window, so a delivery its judge never answers would lose the stake of ${terms.stake} lamports to the owner`, final: true };
  }
  const secs = Math.min(terms.maxSecs, caps.claimSecs, expiresAt - now - CLAIM_MARGIN_SECS - terms.reviewSecs);
  if (!(secs >= MIN_CLAIM_SECS)) {
    return { reason: "the escrow ends too soon, or lets a claim last too briefly, to claim it and leave its judge the whole review window", final: true };
  }
  if (terms.stake > 0n) {
    const total = atRisk(holds) + terms.stake;
    if (total > caps.maxAtRisk) {
      return { reason: `claiming it would put ${total} lamports of stake at risk, above this worker's cap of ${caps.maxAtRisk}`, final: false };
    }
    const owned = atRisk(holds, owner) + terms.stake;
    if (owned > caps.maxPerOwner) {
      return { reason: `claiming it would stake ${owned} lamports on escrows of owner ${owner}, above this worker's cap of ${caps.maxPerOwner} per owner`, final: false };
    }
  }
  return { secs: Math.floor(secs), terms };
}

export const holdOf = (demo: string, job: { intent: string; owner: string; nonce: string }, terms: Terms, until: number): Hold => ({
  intent: job.intent,
  demo,
  owner: job.owner,
  nonce: job.nonce,
  stake: String(terms.stake),
  killFee: String(terms.killFee),
  until,
  reviewUntil: null,
  delivered: false,
  tries: 0,
  nextTry: 0,
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function boardOrNull(cli: Cli, owner: string, nonce: string): Promise<Record<string, unknown> | null> {
  try {
    return record(await cli(["claims", "show", "--owner", owner, "--nonce", nonce]));
  } catch (error) {
    if (/takes no claims/.test(message(error))) {
      return null;
    }
    throw error;
  }
}

async function settleHold(cli: Cli, payer: Payer, ledger: Ledger, hold: Hold, now: number): Promise<Event[]> {
  const board = await boardOrNull(cli, hold.owner, hold.nonce);
  const event = (action: Event["action"], detail: string): Event[] => [{ intent: hold.intent, demo: hold.demo, action, detail }];
  const flags = ["--keypair", payer.keypair, "--owner", hold.owner, "--nonce", hold.nonce, "--yes"];
  if (board === null || textOf(board["worker"]) !== payer.wallet) {
    ledger.holds.delete(hold.intent);
    if (hold.reviewUntil === null && now >= hold.until) {
      ledger.lost += BigInt(hold.stake);
      return event("lost", `the claim lapsed before a review armed, and its stake of ${hold.stake} lamports went to the owner`);
    }
    return event("ended", "the claim is no longer this worker's: a release, reject, cancel or collect settled its stake");
  }
  const review = record(board["review"]);
  if (board["review"] !== null && typeof board["review"] === "object") {
    if (review["lapsed"] !== true) {
      hold.reviewUntil = wholeOf(review["until"]);
      hold.delivered = true;
      hold.tries = 0;
      hold.nextTry = Math.min(hold.reviewUntil, now + REVIEW_RECHECK_SECS);
      return [];
    }
    const signature = sentSignature(await cli(["claims", "collect", ...flags]), "claims collect");
    ledger.holds.delete(hold.intent);
    ledger.collected += BigInt(hold.stake) + BigInt(hold.killFee);
    return event("collected", signature);
  }
  if (board["state"] === "held") {
    const signature = sentSignature(await cli(["claims", "drop", ...flags]), "claims drop");
    ledger.holds.delete(hold.intent);
    return event("dropped", `no review protects this claim, so the worker gave it back with its stake: ${signature}`);
  }
  ledger.holds.delete(hold.intent);
  ledger.lost += BigInt(hold.stake);
  return event("lost", `the claim lapsed before a review armed, and its stake of ${hold.stake} lamports went to the owner`);
}

export async function collectRound(cli: Cli, payer: Payer, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const hold of [...ledger.holds.values()]) {
    if (hold.nextTry > now || (!hold.delivered && !ledger.done.has(hold.intent))) {
      continue;
    }
    try {
      events.push(...(await settleHold(cli, payer, ledger, hold, now)));
    } catch (error) {
      hold.tries += 1;
      hold.nextTry = now + Math.min(COLLECT_RETRY_SECS * 2 ** Math.min(hold.tries - 1, 16), MAX_COLLECT_RETRY_SECS);
      events.push({ intent: hold.intent, demo: hold.demo, action: "failed", detail: `settling its claim failed, try ${hold.tries}: ${message(error)}` });
    }
  }
  return events;
}

export type Health = {
  at: string;
  wallet: string;
  balance_lamports: string | null;
  last_delivery: { at: string; intent: string } | null;
  stake_at_risk_lamports: string;
  claims_held: number;
  uncollected_lamports: string;
  overdue_lamports: string;
  collected_lamports: string;
  lost_lamports: string;
  node_busy_until: string | null;
};

const iso = (secs: number): string => new Date(secs * 1000).toISOString();

export function healthOf(ledger: Ledger, wallet: string, now: number, balance: bigint | null, busyUntilMs: number): Health {
  let uncollected = 0n;
  let overdue = 0n;
  for (const hold of ledger.holds.values()) {
    const owed = BigInt(hold.stake) + BigInt(hold.killFee);
    if (hold.reviewUntil !== null && now >= hold.reviewUntil) {
      uncollected += owed;
    }
    const late = hold.reviewUntil === null ? now >= hold.until + OVERDUE_SECS : now >= hold.reviewUntil + OVERDUE_SECS;
    overdue += late ? (hold.reviewUntil === null ? BigInt(hold.stake) : owed) : 0n;
  }
  return {
    at: iso(now),
    wallet,
    balance_lamports: balance === null ? null : String(balance),
    last_delivery: ledger.lastDelivery === null ? null : { at: iso(ledger.lastDelivery.at), intent: ledger.lastDelivery.intent },
    stake_at_risk_lamports: String(atRisk(ledger.holds.values())),
    claims_held: ledger.holds.size,
    uncollected_lamports: String(uncollected),
    overdue_lamports: String(overdue),
    collected_lamports: String(ledger.collected),
    lost_lamports: String(ledger.lost),
    node_busy_until: busyUntilMs > now * 1000 ? new Date(busyUntilMs).toISOString() : null,
  };
}

async function replace(path: string, text: string): Promise<void> {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

export const writeHealth = (path: string, health: Health): Promise<void> => replace(path, `${JSON.stringify(health)}\n`);

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

function holdFrom(value: unknown, path: string): Hold {
  const held = record(value);
  const text = (key: string) => {
    const found = held[key];
    if (typeof found !== "string" || found === "") {
      throw new Error(`${path} holds a claim without ${key}; fix or remove that entry, so no stake is forgotten`);
    }
    return found;
  };
  const stake = text("stake");
  const killFee = text("killFee");
  if (!/^\d+$/.test(stake) || !/^\d+$/.test(killFee)) {
    throw new Error(`${path} holds a claim whose stake or kill fee is not a whole number of lamports`);
  }
  const until = wholeOf(held["until"]);
  const reviewUntil = held["reviewUntil"] === null || held["reviewUntil"] === undefined ? null : wholeOf(held["reviewUntil"]);
  return { intent: text("intent"), demo: text("demo"), owner: text("owner"), nonce: text("nonce"), stake, killFee, until, reviewUntil, delivered: held["delivered"] === true, tries: wholeOf(held["tries"]), nextTry: wholeOf(held["nextTry"]) };
}

export async function readLedger(path: string): Promise<Ledger> {
  let saved: Record<string, unknown>;
  try {
    saved = record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (record(error)["code"] === "ENOENT") {
      return emptyLedger();
    }
    throw error;
  }
  const ledger = emptyLedger(strings(saved["done"]));
  for (const hold of Array.isArray(saved["holds"]) ? saved["holds"] : []) {
    const read = holdFrom(hold, path);
    ledger.holds.set(read.intent, read);
  }
  const last = record(saved["last_delivery"]);
  ledger.lastDelivery = typeof last["intent"] === "string" ? { at: wholeOf(last["at"]), intent: last["intent"] } : null;
  ledger.collected = BigInt(/^\d+$/.test(String(saved["collected_lamports"])) ? String(saved["collected_lamports"]) : "0");
  ledger.lost = BigInt(/^\d+$/.test(String(saved["lost_lamports"])) ? String(saved["lost_lamports"]) : "0");
  return ledger;
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  const saved = { done: [...ledger.done], holds: [...ledger.holds.values()], last_delivery: ledger.lastDelivery, collected_lamports: String(ledger.collected), lost_lamports: String(ledger.lost) };
  await replace(path, `${JSON.stringify(saved)}\n`);
}
