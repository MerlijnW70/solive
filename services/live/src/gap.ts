import type { ListedSignature } from "@intent-engine/client";
import { beforeWindow, pendingOf } from "./history.js";
import { FEED_GAP_SEQS } from "./limits.js";
import type { Reader } from "./reader.js";
import type { State } from "./shapes.js";

export const cursorOf = (state: State): string | null => state.top ?? state.newest;

export const walking = (state: State): boolean => (state.gaps ?? []).length > 0;

export function advanced(state: State, fresh: readonly ListedSignature[], limit: number): void {
  const newest = fresh[0];
  const last = fresh.at(-1);
  if (newest === undefined || last === undefined) {
    return;
  }
  const cursor = cursorOf(state);
  if (cursor !== null && fresh.length >= limit) {
    const base = (state.next_seq ?? 0) + FEED_GAP_SEQS;
    state.gaps = [...(state.gaps ?? []), { before: last.signature, until: cursor, seq: base }];
    state.next_seq = base;
  }
  if (walking(state)) {
    state.top = newest.signature;
  } else {
    state.newest = newest.signature;
  }
}

export async function walkGap(state: State, reader: Reader, limit: number, now: number): Promise<void> {
  const gap = state.gaps?.[0];
  if (gap === undefined) {
    return;
  }
  const page = await reader.olderSignatures(limit, gap.before, gap.until);
  const queued = new Set([...state.pending, ...(state.backlog ?? [])].map(({ signature }) => signature));
  const inside = (entry: ListedSignature): boolean => !beforeWindow(entry.blockTime === null ? null : Number(entry.blockTime), now);
  const kept = page.flatMap((entry, i) => (!entry.failed && !queued.has(entry.signature) && inside(entry) ? [pendingOf(entry, gap.seq - i)] : []));
  state.backlog = [...kept.reverse(), ...(state.backlog ?? [])];
  gap.seq -= page.length;
  const last = page.at(-1);
  if (last !== undefined && page.length >= limit && page.every(inside)) {
    gap.before = last.signature;
    return;
  }
  state.gaps = (state.gaps ?? []).slice(1);
  if (!walking(state) && state.top !== undefined && state.top !== null) {
    state.newest = state.top;
    state.top = null;
  }
}
