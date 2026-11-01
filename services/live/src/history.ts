import type { ListedSignature } from "@intent-engine/client";
import { PAID_WINDOW_SECS } from "./limits.js";
import type { History, Pending, State } from "./shapes.js";

export const pendingOf = (entry: ListedSignature, seq?: number): Pending => ({
  signature: entry.signature,
  slot: Number(entry.slot),
  blockTime: entry.blockTime === null ? null : Number(entry.blockTime),
  ...(seq === undefined ? {} : { seq }),
});

export function sequenced(state: State, page: readonly ListedSignature[], newer: boolean): Map<string, number> {
  const seqs = new Map<string, number>();
  if (newer) {
    const base = state.next_seq ?? 0;
    page.forEach((entry, i) => seqs.set(entry.signature, base + page.length - i));
    state.next_seq = base + page.length;
  } else {
    const base = state.low_seq ?? 0;
    page.forEach((entry, i) => seqs.set(entry.signature, base - 1 - i));
    state.low_seq = base - page.length;
  }
  return seqs;
}

const secsOf = (blockTime: bigint | null): number | null => (blockTime === null ? null : Number(blockTime));

export const beforeWindow = (blockTime: number | null, now: number): boolean => blockTime !== null && blockTime * 1000 < now - PAID_WINDOW_SECS * 1000;

export function historyOf(state: State, now: number): void {
  state.backlog ??= [];
  if (state.backfilled !== undefined) {
    return;
  }
  const tail = [...state.events].sort((a, b) => b.slot - a.slot).at(-1);
  const reach = tail === undefined ? null : Math.floor(Date.parse(tail.at) / 1000);
  state.oldest = tail?.signature ?? null;
  state.oldest_at = reach;
  state.backfilled = beforeWindow(reach, now);
}

export function reached(state: State, page: readonly ListedSignature[], limit: number, now: number): void {
  const last = page.at(-1);
  if (last !== undefined) {
    state.oldest = last.signature;
    state.oldest_at = secsOf(last.blockTime) ?? state.oldest_at ?? null;
  }
  state.backfilled = page.length < limit || page.some(({ blockTime }) => beforeWindow(secsOf(blockTime), now));
}

export function queueOlder(state: State, page: readonly ListedSignature[], now: number): void {
  const seqs = sequenced(state, page, false);
  const queued = new Set([...state.pending, ...(state.backlog ?? [])].map(({ signature }) => signature));
  const kept = page.filter((entry) => !entry.failed && !queued.has(entry.signature) && !beforeWindow(secsOf(entry.blockTime), now)).map((entry) => pendingOf(entry, seqs.get(entry.signature)));
  state.backlog = [...kept.reverse(), ...(state.backlog ?? [])];
}

export const wantsOlder = (state: State, room: number): boolean => state.backfilled !== true && (state.backlog ?? []).length < room;

export function historyView(state: State): History {
  const reach = state.oldest_at ?? null;
  return {
    complete: state.backfilled === true && (state.backlog ?? []).length === 0,
    since: reach === null ? null : new Date(reach * 1000).toISOString(),
  };
}
