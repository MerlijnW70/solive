import { onDevnet, openBacking, openEscrowsOf, paidBacking, type MirrorRpc } from "./chain.js";
import { MAX_CHECKS_PER_SWEEP, MAX_EVICTIONS_PER_PUT, MAX_ROOM_LOOKUPS_PER_PUT, ORPHAN_SECS, PAID_GRACE_SECS, SWEEP_BUDGET_MS, UNPAID_GRACE_SECS } from "./limits.js";
import { backs, COST_MINT, type Grace, IDLE_PREFIX, idleMark, lockedBy, OWNER_PREFIX, parseOwnerMark } from "./owners.js";
import { SPEC_PREFIX, specPath, type Listed, type SpecStore } from "./store.js";

export type SweepDeps = {
  readonly rpc: () => MirrorRpc;
  readonly store: SpecStore;
  readonly now: () => number;
};

export type Swept = { kept: number; idled: number; expired: number; orphans: number; left: number };

type Idle = Listed & { readonly hex: string; readonly grace: Grace };
type Marks = { readonly owned: Map<string, Listed[]>; readonly idle: Map<string, Idle[]> };

const SPEC = /^sha256\/([0-9a-f]{64})$/;
const IDLE = /^idle\/([0-9a-f]{64})\.(paid|unpaid)$/;

function grouped<T extends Listed>(entries: readonly T[], hexOf: (entry: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const hex = hexOf(entry);
    groups.set(hex, [...(groups.get(hex) ?? []), entry]);
  }
  return groups;
}

async function specsOf(store: SpecStore): Promise<(Listed & { readonly hex: string })[]> {
  return (await store.list(SPEC_PREFIX)).flatMap((entry) => {
    const hex = SPEC.exec(entry.pathname)?.[1];
    return hex === undefined ? [] : [{ ...entry, hex }];
  });
}

async function marksOf(store: SpecStore): Promise<Marks> {
  const idle = (await store.list(IDLE_PREFIX)).flatMap((entry): Idle[] => {
    const found = IDLE.exec(entry.pathname);
    return found === null ? [] : [{ ...entry, hex: found[1] as string, grace: found[2] as Grace }];
  });
  return {
    owned: grouped(await store.list(OWNER_PREFIX), (entry) => parseOwnerMark(entry.pathname).hex),
    idle: grouped(idle, (entry) => entry.hex),
  };
}

const pathsOf = (hex: string, marks: Marks): string[] => [...(marks.owned.get(hex) ?? []), ...(marks.idle.get(hex) ?? [])].map((entry) => entry.pathname);

async function evict(hex: string, size: number, marks: Marks, rpc: MirrorRpc, store: SpecStore): Promise<boolean> {
  if (backs(lockedBy(await openEscrowsOf(rpc, hex)), size)) return false;
  await store.remove([specPath(hex), ...pathsOf(hex, marks)]);
  return true;
}

const paidFor = async (rpc: MirrorRpc, spec: { readonly hex: string; readonly size: number }): Promise<boolean> => backs(await paidBacking(rpc, spec.hex, COST_MINT), spec.size);

export async function sweep(deps: SweepDeps): Promise<Swept> {
  const started = deps.now();
  const rpc = deps.rpc();
  if (!(await onDevnet(rpc))) throw new Error("the node of this service is not on devnet");
  const locked = await openBacking(rpc, COST_MINT);
  const specs = await specsOf(deps.store);
  const marks = await marksOf(deps.store);
  const stored = new Set(specs.map((spec) => spec.hex));
  const dropped: string[] = [];
  const swept: Swept = { kept: 0, idled: 0, expired: 0, orphans: 0, left: 0 };
  let checks = 0;
  const spent = () => checks >= MAX_CHECKS_PER_SWEEP || deps.now() - started >= SWEEP_BUDGET_MS;
  try {
    for (const spec of specs) {
      const idle = marks.idle.get(spec.hex) ?? [];
      if (backs(locked.get(spec.hex) ?? 0n, spec.size)) {
        swept.kept += 1;
        dropped.push(...idle.map((mark) => mark.pathname));
        continue;
      }
      if (idle.length > 0) {
        const since = Math.max(...idle.map((mark) => mark.uploadedAt));
        const grace = idle.some((mark) => mark.grace === "paid") ? PAID_GRACE_SECS : UNPAID_GRACE_SECS;
        if (deps.now() - since < grace * 1000) {
          swept.kept += 1;
          continue;
        }
      }
      if (spent()) {
        swept.left += 1;
        continue;
      }
      checks += 1;
      const paid = await paidFor(rpc, spec);
      if (idle.length === 0) {
        await deps.store.mark(idleMark(spec.hex, paid ? "paid" : "unpaid"));
        swept.idled += 1;
      } else if (paid && deps.now() - Math.max(...idle.map((mark) => mark.uploadedAt)) < PAID_GRACE_SECS * 1000) swept.kept += 1;
      else if (await evict(spec.hex, spec.size, marks, rpc, deps.store)) swept.expired += 1;
      else swept.kept += 1;
    }
  } finally {
    const orphaned = (groups: Map<string, Listed[]>) =>
      [...groups].filter(([hex]) => !stored.has(hex)).flatMap(([, entries]) => entries.filter((entry) => deps.now() - entry.uploadedAt >= ORPHAN_SECS * 1000));
    const orphans = [...orphaned(marks.owned), ...orphaned(marks.idle)].map((entry) => entry.pathname);
    swept.orphans = orphans.length;
    await deps.store.remove([...dropped, ...orphans]);
  }
  return swept;
}

const paidMarked = (marks: Marks, hex: string, now: number): boolean =>
  (marks.idle.get(hex) ?? []).some((mark) => mark.grace === "paid" && now - mark.uploadedAt < PAID_GRACE_SECS * 1000);

export async function makeRoom(rpc: MirrorRpc, store: SpecStore, wanted: number, now: number): Promise<number> {
  const locked = await openBacking(rpc, COST_MINT);
  const marks = await marksOf(store);
  const unbacked = (await specsOf(store))
    .filter((spec) => !backs(locked.get(spec.hex) ?? 0n, spec.size) && !paidMarked(marks, spec.hex, now))
    .sort((a, b) => a.uploadedAt - b.uploadedAt);
  let freed = 0;
  let evictions = 0;
  let lookups = 0;
  for (const spec of unbacked) {
    if (freed >= wanted || evictions >= MAX_EVICTIONS_PER_PUT || lookups + 2 > MAX_ROOM_LOOKUPS_PER_PUT) break;
    lookups += 1;
    if (await paidFor(rpc, spec)) {
      await store.mark(idleMark(spec.hex, "paid"));
      continue;
    }
    evictions += 1;
    lookups += 1;
    if (await evict(spec.hex, spec.size, marks, rpc, store)) freed += spec.size;
  }
  return freed;
}
