import { type Cli, type Event, record, sentSignature, textOf } from "./demo-chain.mts";
import { type Hold, type Ledger, type Strike, type StrikeKind, replaceFile } from "./demo-state.mts";

export type Breaker = { strikes: number; ownerStrikes: number; windowSecs: number };

export type Caps = { maxStake: bigint; maxAtRisk: bigint; maxPerOwner: bigint; claimSecs: number; maxReviewSecs: number; maxOpenDeliveries: number; breaker: Breaker };

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

const recentOf = (strikes: readonly Strike[], now: number, windowSecs: number, owner?: string): Strike[] => strikes.filter((each) => each.at > now - windowSecs && (owner === undefined || each.owner === owner));

export function breakerUntil(strikes: readonly Strike[], now: number, breaker: Breaker, owner?: string): number | null {
  const limit = owner === undefined ? breaker.strikes : breaker.ownerStrikes;
  const times = recentOf(strikes, now, breaker.windowSecs, owner)
    .map((each) => each.at)
    .sort((a, b) => a - b);
  const opening = times[times.length - limit];
  return times.length >= limit && opening !== undefined ? opening + breaker.windowSecs : null;
}

export function strike(ledger: Ledger, owner: string, now: number, kind: StrikeKind, lamports: bigint, breaker: Breaker): void {
  ledger.strikes = [...recentOf(ledger.strikes, now, breaker.windowSecs), { at: now, owner, kind, lamports: String(lamports) }];
}

export function claimPlan(terms: Terms, owner: string, expiresAt: number, now: number, caps: Caps, holds: readonly Hold[], strikes: readonly Strike[] = []): Plan | Refusal {
  if (terms.stake > caps.maxStake) {
    return { reason: `its claim stake of ${terms.stake} lamports is above this worker's cap of ${caps.maxStake}`, final: true };
  }
  if (terms.stake > 0n && terms.reviewSecs === 0) {
    return { reason: `its claims open no review window, so a delivery its judge never answers would lose the stake of ${terms.stake} lamports to the owner`, final: true };
  }
  if (terms.stake > 0n && terms.reviewSecs > caps.maxReviewSecs) {
    return { reason: `its review window of ${terms.reviewSecs} seconds is longer than this worker's cap of ${caps.maxReviewSecs}, so its stake would stay locked too long`, final: true };
  }
  const secs = Math.min(terms.maxSecs, caps.claimSecs, expiresAt - now - CLAIM_MARGIN_SECS - terms.reviewSecs);
  if (!(secs >= MIN_CLAIM_SECS)) {
    return { reason: "the escrow ends too soon, or lets a claim last too briefly, to claim it and leave its judge the whole review window", final: true };
  }
  if (terms.stake > 0n) {
    const shut = breakerUntil(strikes, now, caps.breaker);
    if (shut !== null) {
      return { reason: `the breaker is open after ${caps.breaker.strikes} lost or failed claims within ${caps.breaker.windowSecs} seconds, so this worker takes no staked claim until ${shut}`, final: false };
    }
    const shutOwner = breakerUntil(strikes, now, caps.breaker, owner);
    if (shutOwner !== null) {
      return { reason: `the breaker is open for owner ${owner} after ${caps.breaker.ownerStrikes} lost or failed claims on its escrows, so this worker takes no staked claim of it until ${shutOwner}`, final: false };
    }
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

export type Settler = Payer & Pick<Caps, "breaker">;

function lose(ledger: Ledger, hold: Hold, now: number, settler: Settler): Event[] {
  ledger.holds.delete(hold.intent);
  ledger.lost += BigInt(hold.stake);
  strike(ledger, hold.owner, now, "lost", BigInt(hold.stake), settler.breaker);
  return [{ intent: hold.intent, demo: hold.demo, action: "lost", detail: `the claim lapsed before a review armed, and its stake of ${hold.stake} lamports went to the owner` }];
}

async function settleHold(cli: Cli, settler: Settler, ledger: Ledger, hold: Hold, now: number): Promise<Event[]> {
  const board = await boardOrNull(cli, hold.owner, hold.nonce);
  const event = (action: Event["action"], detail: string): Event[] => [{ intent: hold.intent, demo: hold.demo, action, detail }];
  const flags = ["--keypair", settler.keypair, "--owner", hold.owner, "--nonce", hold.nonce, "--yes"];
  if (board === null || textOf(board["worker"]) !== settler.wallet) {
    if (hold.reviewUntil === null && now >= hold.until) {
      return lose(ledger, hold, now, settler);
    }
    ledger.holds.delete(hold.intent);
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
  return lose(ledger, hold, now, settler);
}

export async function collectRound(cli: Cli, settler: Settler, ledger: Ledger, now: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const hold of [...ledger.holds.values()]) {
    const working = !hold.delivered && !ledger.done.has(hold.intent) && now < hold.until - CLAIM_MARGIN_SECS;
    if (hold.nextTry > now || working) {
      continue;
    }
    try {
      events.push(...(await settleHold(cli, settler, ledger, hold, now)));
    } catch (error) {
      hold.tries += 1;
      hold.nextTry = now + Math.min(COLLECT_RETRY_SECS * 2 ** Math.min(hold.tries - 1, 16), MAX_COLLECT_RETRY_SECS);
      events.push({ intent: hold.intent, demo: hold.demo, action: "failed", detail: `settling its claim failed, try ${hold.tries}: ${message(error)}` });
    }
  }
  return events;
}

export async function reclaimRound(cli: Cli, payer: Payer, ledger: Ledger): Promise<Event[]> {
  const shown = record(await cli(["reclaim", "--keypair", payer.keypair, "--yes"]));
  const closed = Array.isArray(shown["closed"]) ? shown["closed"].length : 0;
  const kept = Array.isArray(shown["kept"]) ? shown["kept"].length : null;
  if (kept === null) {
    throw new Error(`reclaim listed no announcements it keeps: ${JSON.stringify(shown).slice(0, 300)}`);
  }
  ledger.openDeliveries = kept;
  return closed === 0 ? [] : [{ intent: payer.wallet, demo: "reclaim", action: "reclaimed", detail: `closed ${closed} announcements of this worker and got their rent back; ${kept} stay open` }];
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
  lost_recent_lamports: string;
  strikes_recent: number;
  breaker_until: string | null;
  open_deliveries: number;
  state_recovered: string | null;
  node_busy_until: string | null;
  alerts: string[];
};

const iso = (secs: number): string => new Date(secs * 1000).toISOString();

export function healthOf(ledger: Ledger, wallet: string, now: number, balance: bigint | null, busyUntilMs: number, caps: Pick<Caps, "breaker" | "maxOpenDeliveries">): Health {
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
  const recent = recentOf(ledger.strikes, now, caps.breaker.windowSecs);
  const lostRecent = recent.filter((each) => each.kind === "lost").reduce((sum, each) => sum + BigInt(each.lamports), 0n);
  const shut = breakerUntil(ledger.strikes, now, caps.breaker);
  const alerts = [
    ...(overdue > 0n ? ["overdue"] : []),
    ...(lostRecent > 0n ? ["lost"] : []),
    ...(shut !== null ? ["breaker"] : []),
    ...(ledger.openDeliveries >= caps.maxOpenDeliveries ? ["rent"] : []),
    ...(ledger.recovered !== null ? ["state"] : []),
  ];
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
    lost_recent_lamports: String(lostRecent),
    strikes_recent: recent.length,
    breaker_until: shut === null ? null : iso(shut),
    open_deliveries: ledger.openDeliveries,
    state_recovered: ledger.recovered,
    node_busy_until: busyUntilMs > now * 1000 ? new Date(busyUntilMs).toISOString() : null,
    alerts,
  };
}

export const writeHealth = (path: string, health: Health): Promise<void> => replaceFile(path, `${JSON.stringify(health)}\n`, false);
