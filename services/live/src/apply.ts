import type { EngineTransaction, IntentAccount } from "@intent-engine/client";
import { Kind, termsOf } from "@intent-engine/core";
import { type Activity, activitiesOf, createdJobs, hexOf } from "./activity.js";
import { specName } from "./catalog.js";
import { FEED_EVENTS, KEPT_JOBS, KEPT_PAID, PAID_WINDOW_SECS } from "./limits.js";
import type { FeedEvent, Job, Paid, State, Step } from "./shapes.js";
import { amountText, detailOf, tokenOf } from "./words.js";

export function isHouse(activity: Activity, job: Job | undefined, house: ReadonlySet<string>): boolean {
  const parties = [activity.who, activity.payee, activity.attestor].filter((party): party is string => party !== undefined);
  if (parties.some((party) => house.has(party))) {
    return true;
  }
  const owner = activity.owner ?? job?.owner;
  const judge = job?.attestor ?? activity.attestor;
  return owner !== undefined && owner !== null && judge !== undefined && owner === judge;
}

function jobAt(state: State, intent: string, slot: number): Job {
  const job = state.jobs[intent] ?? { slot };
  job.slot = Math.max(job.slot, slot);
  state.jobs[intent] = job;
  return job;
}

const isoOf = (blockTime: bigint | null, fallback: number): string => new Date(blockTime === null ? fallback : Number(blockTime) * 1000).toISOString();

function pay(state: State, entries: readonly Paid[]): void {
  for (const entry of entries) {
    if (!state.paid.some((known) => known.intent === entry.intent && known.slot === entry.slot && known.payee === entry.payee)) {
      state.paid.push(entry);
    }
  }
}

function settle(state: State, intent: string, job: Job): void {
  const held = job.unpriced;
  const places = job.mint === undefined ? undefined : state.decimals[job.mint];
  if (held === undefined || job.mint === undefined || places === undefined) {
    return;
  }
  const selfJudged = job.owner !== undefined && job.owner === job.attestor;
  const { shares, ...entry } = held;
  const mint = job.mint;
  pay(state, shares.map((share) => ({ ...entry, ...share, house: entry.house || selfJudged, intent, token: tokenOf(mint), decimals: places })));
  delete job.unpriced;
}

export function applyTransactions(state: State, transactions: readonly EngineTransaction[], house: ReadonlySet<string>, now: number): number {
  let added = 0;
  for (const tx of transactions) {
    if (tx.failed) {
      continue;
    }
    const slot = Number(tx.slot);
    const at = isoOf(tx.blockTime, now);
    for (const created of createdJobs(tx)) {
      const job = jobAt(state, created.intent, slot);
      job.owner = created.owner;
      job.mint = created.mint;
    }
    for (const activity of activitiesOf(tx, state.jobs)) {
      const job = jobAt(state, activity.intent, slot);
      if (activity.kind === "escrow") {
        if (activity.attestor !== undefined) {
          job.attestor = activity.attestor;
        }
        if (activity.specHash !== undefined && activity.specHash !== null) {
          job.spec_hash = activity.specHash;
        }
      }
      const places = activity.raw === null || activity.mint === null ? null : (state.decimals[activity.mint] ?? null);
      const amount = activity.raw === null || places === null ? null : amountText(activity.raw, places);
      const token = activity.mint === null || amount === null ? null : tokenOf(activity.mint);
      const hash = activity.kind === "escrow" ? (activity.specHash ?? null) : null;
      const name = specName(hash);
      const marked = isHouse(activity, job, house);
      const event: FeedEvent = {
        kind: activity.kind,
        at,
        slot,
        signature: tx.signature,
        intent: activity.intent,
        who: activity.who,
        amount,
        token,
        house: marked,
        spec_hash: hash,
        spec_name: name,
        detail: detailOf(activity, amount, token, name),
        ...(activity.kind === "release" ? { payee: activity.payee ?? activity.who, attestor: activity.attestor ?? activity.who } : {}),
      };
      if (!state.events.some((known) => known.signature === event.signature && known.kind === event.kind && known.intent === event.intent && known.who === event.who)) {
        state.events.unshift(event);
        added += 1;
      }
      const step: Step = { signature: tx.signature, at, who: activity.who, amount, token };
      if (activity.kind === "escrow") {
        job.escrow = step;
      }
      if (activity.kind === "delivery" && slot >= (job.delivery_slot ?? 0)) {
        job.delivery = step;
        job.delivery_slot = slot;
      }
      if (activity.kind === "release") {
        if (slot >= (state.latest_paid_slot ?? 0)) {
          const jobHash = job.spec_hash ?? null;
          state.latest_paid_job = { intent: activity.intent, spec_hash: jobHash, spec_name: specName(jobHash), escrow: job.escrow ?? null, delivery: job.delivery ?? null, release: step };
          state.latest_paid_slot = slot;
        }
        const payee = event.payee ?? activity.who;
        const shares = (activity.shares ?? (activity.raw === null ? [] : [{ payee, raw: activity.raw }])).map((share) => ({ payee: share.payee, raw: share.raw.toString() }));
        if (amount !== null && token !== null && activity.raw !== null && places !== null) {
          pay(state, shares.map((share) => ({ at, slot, signature: tx.signature, intent: activity.intent, ...share, token, decimals: places, house: marked })));
        } else if (activity.mint === null && activity.raw !== null) {
          job.unpriced = { at, slot, signature: tx.signature, house: marked, shares };
        }
      }
    }
    for (const created of createdJobs(tx)) {
      const job = state.jobs[created.intent];
      if (job !== undefined) {
        settle(state, created.intent, job);
      }
    }
  }
  return added;
}

export function applyOpenJobs(state: State, intents: readonly IntentAccount[], now: number): void {
  const nowSecs = BigInt(Math.floor(now / 1000));
  let open = 0;
  for (const { address, intent } of intents) {
    if (intent.kind !== Kind.AttestedResult || intent.expiresAt <= nowSecs) {
      continue;
    }
    open += 1;
    const known = state.jobs[address] ?? { slot: 0 };
    state.jobs[address] = known;
    known.owner = intent.owner;
    known.mint = intent.inputMint;
    try {
      const { params } = termsOf(intent);
      if (params.kind === Kind.AttestedResult) {
        known.attestor = params.attestor;
        known.spec_hash = hexOf(params.specHash);
      }
    } catch {
      continue;
    }
  }
  state.open_jobs = open;
}

export function pruned(state: State, now: number): void {
  state.events = state.events.sort((a, b) => b.slot - a.slot).slice(0, FEED_EVENTS);
  const floor = now - PAID_WINDOW_SECS * 1000;
  state.paid = state.paid
    .filter(({ at }) => Date.parse(at) >= floor)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.slot - b.slot)
    .slice(-KEPT_PAID);
  const kept = Object.entries(state.jobs)
    .sort(([, a], [, b]) => b.slot - a.slot)
    .slice(0, KEPT_JOBS);
  state.jobs = Object.fromEntries(kept);
}
