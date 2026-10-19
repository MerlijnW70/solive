import type { Address } from "@solana/kit";
import { NATIVE_MINT } from "@intent-engine/core";
import { HISTORY_LIMIT } from "./client-types.js";
import { DELIVERY_PAGES, scan } from "./job-scan.js";
import { eventsOf, type Read, releaseOf, splitClaim } from "./release-reads.js";
import { counted, type Reputation, reputationOf } from "./reputation.js";
import type { Transport } from "./transport.js";

export const RESTART = 0.15;
export const TRUST_HOPS = 2;
export const TRUST_WALLETS = 32;
export const TRUST_PATHS = 3;
const RESIDUAL = 1e-12;
const PATH_STEPS = 10_000;

export type TrustPath = { wallets: Address[]; trust: number };

export type Trust = {
  reader: Address;
  worker: Address;
  seeds: Address[];
  score: number;
  complete: boolean;
  wallets: number;
  paths: TrustPath[];
  reason?: string;
};

export type TrustOptions = { seeds?: readonly Address[]; pages?: number; history?: number; maxWallets?: number };

type Edge = { to: Address; share: number };

type Paid = { workers: Address[]; complete: boolean };

function paidWallets({ event, transaction }: Read, intent: Address): Address[] | null {
  if (event.name === "IntentAttested") {
    const payee = event.fields.payee;
    const owner = transaction.tokens?.find(({ account }) => account === payee)?.owner;
    return owner === undefined ? null : [owner];
  }
  const claim = splitClaim(transaction, intent);
  return claim === null ? null : [...claim.recipients];
}

async function paidBy(transport: Transport, payer: Address, pages: number, history: number, covered: () => Promise<boolean>): Promise<Paid> {
  const scanned = await scan(transport, payer, { pages, covered });
  const intents = new Set<Address>();
  for (const { event } of eventsOf(scanned.transactions)) {
    if (event.name === "IntentCreated" && event.fields.owner === payer) {
      intents.add(event.fields.intent);
    }
  }
  let complete = scanned.complete;
  const workers = new Set<Address>();
  for (const intent of intents) {
    const transactions = await transport.engineTransactions(history, intent);
    const release = releaseOf(transactions, intent);
    if (release === undefined) {
      complete &&= transactions.length < history;
      continue;
    }
    const paid = paidWallets(release, intent);
    if (paid === null) {
      complete = false;
      continue;
    }
    for (const wallet of paid) {
      if (wallet !== payer) {
        workers.add(wallet);
      }
    }
  }
  return { workers: [...workers], complete };
}

function backedBy(rep: Reputation, payer: Address): bigint {
  return rep.records
    .filter((record) => counted(record) && record.owner === payer)
    .reduce((sum, record) => sum + (record.mint === NATIVE_MINT ? (record.backed ?? 0n) : 0n) + (record.createBacked ?? 0n), 0n);
}

function pushed(seeds: readonly Address[], edges: ReadonlyMap<Address, Edge[]>): Map<Address, number> {
  const score = new Map<Address, number>();
  const residual = new Map<Address, number>(seeds.map((seed) => [seed, 1 / seeds.length]));
  const queue = [...seeds];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const wallet = queue.shift() as Address;
    queued.delete(wallet);
    const held = residual.get(wallet) ?? 0;
    residual.set(wallet, 0);
    score.set(wallet, (score.get(wallet) ?? 0) + RESTART * held);
    for (const { to, share } of edges.get(wallet) ?? []) {
      const next = (residual.get(to) ?? 0) + (1 - RESTART) * held * share;
      residual.set(to, next);
      if (next > RESIDUAL && !queued.has(to)) {
        queue.push(to);
        queued.add(to);
      }
    }
  }
  return score;
}

function strongestPaths(seeds: readonly Address[], worker: Address, edges: ReadonlyMap<Address, Edge[]>): TrustPath[] {
  const found: TrustPath[] = [];
  let steps = 0;
  const walk = (path: Address[], trust: number): void => {
    const at = path[path.length - 1] as Address;
    if (at === worker) {
      found.push({ wallets: [...path], trust });
      return;
    }
    for (const { to, share } of edges.get(at) ?? []) {
      if (steps++ >= PATH_STEPS || path.includes(to)) {
        continue;
      }
      path.push(to);
      walk(path, trust * (1 - RESTART) * share);
      path.pop();
    }
  };
  for (const seed of seeds) {
    walk([seed], RESTART / seeds.length);
  }
  return found.sort((a, b) => b.trust - a.trust).slice(0, TRUST_PATHS);
}

function reasonFor(reader: Address, seeds: readonly Address[], worker: Address, hops: ReadonlyMap<Address, number>, edges: ReadonlyMap<Address, Edge[]>): string {
  if (seeds.every((seed) => (edges.get(seed) ?? []).length === 0)) {
    return seeds.length === 1
      ? `${reader} paid no counted release and no other seed was named, so no trust flows from it`
      : "no seed paid a counted release, so no trust flows from them";
  }
  return hops.has(worker)
    ? `no counted release path from a seed carries trust to ${worker}`
    : `no counted release path from a seed reaches ${worker} within ${TRUST_HOPS} hops`;
}

export async function trustOf(transport: Transport, reader: Address, worker: Address, options: TrustOptions = {}): Promise<Trust> {
  const seeds = [...new Set([reader, ...(options.seeds ?? [])])];
  const pages = options.pages ?? DELIVERY_PAGES;
  const history = options.history ?? HISTORY_LIMIT;
  const maxWallets = options.maxWallets ?? TRUST_WALLETS;
  const { firstAvailableSlot } = transport;
  const covered = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) === 0n;
  const read = new Set<Address>(seeds);
  const reputations = new Map<Address, Promise<Reputation>>();
  let complete = seeds.length <= maxWallets;
  const reputation = (wallet: Address) => {
    const held = reputations.get(wallet) ?? reputationOf(transport, wallet, { pages, history });
    reputations.set(wallet, held);
    return held;
  };
  const hops = new Map<Address, number>(seeds.map((seed) => [seed, 0]));
  const edges = new Map<Address, Edge[]>();
  const queue = [...seeds];
  for (let at = 0; at < queue.length; at++) {
    const payer = queue[at] as Address;
    const hop = hops.get(payer) ?? 0;
    const weights: { to: Address; weight: bigint }[] = [];
    try {
      const paid = await paidBy(transport, payer, pages, history, covered);
      complete &&= paid.complete;
      for (const to of paid.workers) {
        if (!read.has(to) && read.size >= maxWallets) {
          complete = false;
          continue;
        }
        read.add(to);
        const rep = await reputation(to);
        complete &&= rep.complete;
        const weight = backedBy(rep, payer);
        if (weight > 0n) {
          weights.push({ to, weight });
        }
      }
    } catch {
      complete = false;
    }
    const total = weights.reduce((sum, { weight }) => sum + weight, 0n);
    const kept: Edge[] = [];
    for (const { to, weight } of weights) {
      if (!hops.has(to)) {
        if (hop >= TRUST_HOPS) {
          complete = false;
          continue;
        }
        hops.set(to, hop + 1);
        queue.push(to);
      }
      kept.push({ to, share: Number(weight) / Number(total) });
    }
    edges.set(payer, kept);
  }
  const score = pushed(seeds, edges).get(worker) ?? 0;
  return {
    reader,
    worker,
    seeds,
    score,
    complete,
    wallets: read.size,
    paths: score > 0 ? strongestPaths(seeds, worker, edges) : [],
    ...(score > 0 ? {} : { reason: reasonFor(reader, seeds, worker, hops, edges) }),
  };
}
