import { type Address, isAddress } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { remainingOf, type UnreadableAccount } from "@intent-engine/core/internal";
import type { EngineTransaction, ListedSignature, Transport } from "@intent-engine/client";
import { boundMembers, jobClaimOf, loadClaimsOf, openProofEscrows, type PayTerms, type Proof, releaseNet, specUrlOf, TRANSACTION_FETCHES } from "@intent-engine/client/internal";
import { decimalsOnce, freezeAuthorityRead, type JobsWanted, leastUnits, mintsOnce, type PricedJob } from "./job-filters.js";

export const FIND_DEFAULT = 5;
export const SCAN_BATCH = TRANSACTION_FETCHES;
export const SCAN_BUDGET_MS = 5_000;

export type Readable = (transport: Transport, intent: Address) => Promise<boolean>;

export type PageWanted = JobsWanted & { limit: number; all: boolean; after?: Cursor | undefined };

export type Cursor = { createdAt: bigint; expiresAt: bigint; intent: Address };

export type JobPage = { jobs: PricedJob[]; unreadable: UnreadableAccount[]; more?: string };

export type PageOptions = { budgetMs?: number; elapsed?: () => number; pause?: (ms: number) => Promise<void> };

const CURSOR = /^(\d{1,20})\.(\d{1,20})\.([1-9A-HJ-NP-Za-km-z]{32,44})$/;

export function cursorText({ createdAt, expiresAt, intent }: Cursor): string {
  return `${createdAt}.${expiresAt}.${intent}`;
}

export function cursorOf(text: string): Cursor | null {
  const [, created, expires, intent] = CURSOR.exec(text) ?? [];
  return created === undefined || expires === undefined || intent === undefined || !isAddress(intent) ? null : { createdAt: BigInt(created), expiresAt: BigInt(expires), intent };
}

const keyOf = ({ address, intent }: Proof): Cursor => ({ createdAt: intent.createdAt, expiresAt: intent.expiresAt, intent: address });

export function newestFirst(a: Cursor, b: Cursor): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt > b.createdAt ? -1 : 1;
  }
  if (a.expiresAt !== b.expiresAt) {
    return a.expiresAt > b.expiresAt ? -1 : 1;
  }
  return a.intent === b.intent ? 0 : a.intent < b.intent ? -1 : 1;
}

const pageKey = (of: Address, limit: number, before?: string): string => `${of} ${limit} ${before ?? ""}`;

export function historyOnce(transport: Transport): Transport {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    return transport;
  }
  const signatures = new Map<string, Promise<ListedSignature[]>>();
  const transactions = new Map<string, Promise<EngineTransaction[]>>();
  const once = <T>(seen: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
    const known = seen.get(key) ?? read();
    seen.set(key, known);
    known.catch(() => seen.delete(key));
    return known;
  };
  const listed = async (of: Address, limit: number, before?: string): Promise<ListedSignature[]> => {
    const page = await signaturesOf.call(transport, of, limit, before);
    const oldest = page[page.length - 1];
    if (page.length < limit && oldest !== undefined) {
      signatures.set(pageKey(of, limit, oldest.signature), Promise.resolve([]));
    }
    return page;
  };
  return {
    ...boundMembers(transport),
    signaturesOf: (of, limit, before) => once(signatures, pageKey(of, limit, before), () => listed(of, limit, before)),
    transactionsOf: (listed) => once(transactions, listed.map(({ signature }) => signature).join(" "), () => transactionsOf.call(transport, listed)),
  };
}

async function within<T>(work: Promise<T>, ms: number, pause?: (ms: number) => Promise<void>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = pause === undefined ? new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))) : pause(ms).then(() => undefined);
  try {
    return await Promise.race([work, stop]);
  } finally {
    clearTimeout(timer);
  }
}

async function minPaid(proofs: Proof[], minPay: string | undefined, decimalsOf: (mint: Address) => Promise<number>): Promise<Proof[]> {
  if (minPay === undefined) {
    return proofs;
  }
  const mints = [...new Set(proofs.map(({ intent }) => intent.inputMint))];
  const least = new Map(await Promise.all(mints.map(async (mint) => [mint, leastUnits(minPay, await decimalsOf(mint))] as const)));
  return proofs.filter(({ intent }) => remainingOf(intent) >= (least.get(intent.inputMint) ?? 0n));
}

type Found = { proof: Proof; url: string | null };

async function jobRead(transport: Transport, proof: Proof, all: boolean, readable: Readable): Promise<Found | null> {
  const url = await specUrlOf(transport, proof.address, proof.intent.createdAt, proof.intent.owner);
  return all || (url !== null && (await readable(transport, proof.address))) ? { proof, url } : null;
}

const before = (first: Proof): Cursor => ({ ...keyOf(first), createdAt: first.intent.createdAt + 1n });

async function scanned(transport: Transport, queue: readonly Proof[], wanted: PageWanted, readable: Readable, options: PageOptions) {
  const { budgetMs = SCAN_BUDGET_MS, elapsed = performance.now.bind(performance), pause } = options;
  const started = elapsed();
  const kept: Found[] = [];
  let at = 0;
  for (let left = budgetMs; at < queue.length && kept.length < wanted.limit && left > 0; left = budgetMs - (elapsed() - started)) {
    const batch = queue.slice(at, at + SCAN_BATCH);
    const done: (Found | null | undefined)[] = batch.map(() => undefined);
    const reads = batch.map((proof, i) => jobRead(transport, proof, wanted.all, readable).then((found) => (done[i] = found)));
    const whole = await within(Promise.all(reads), left, pause);
    for (const found of done) {
      if (kept.length === wanted.limit || found === undefined) {
        break;
      }
      at++;
      if (found !== null) {
        kept.push(found);
      }
    }
    if (whole === undefined) {
      break;
    }
  }
  const last = queue[at - 1];
  const first = queue[0];
  if (at === queue.length || first === undefined) {
    return { kept };
  }
  return { kept, more: cursorText(last === undefined ? (wanted.after ?? before(first)) : keyOf(last)) };
}

async function wholeTokens(raw: bigint, decimals: Promise<number>): Promise<string | null> {
  try {
    return formatAmount(raw, await decimals);
  } catch {
    return null;
  }
}

async function priced(transport: Transport, kept: readonly Found[], terms: PayTerms, mintsOf: ReturnType<typeof mintsOnce>, decimalsOf: (mint: Address) => Promise<number>): Promise<PricedJob[]> {
  const [claims, freezes, whole] = await Promise.all([
    loadClaimsOf(transport, kept.map(({ proof }) => proof.address)),
    Promise.all(kept.map(({ proof }) => freezeAuthorityRead(mintsOf(proof.intent.inputMint)))),
    Promise.all(kept.map(({ proof }) => wholeTokens(remainingOf(proof.intent), decimalsOf(proof.intent.inputMint)))),
  ]);
  return Promise.all(
    kept.map(async ({ proof: { address, intent, params }, url }, i) => {
      const net = releaseNet(intent, terms);
      const netPay = net === null ? null : await wholeTokens(net, decimalsOf(intent.inputMint));
      return {
        intent: address,
        owner: intent.owner,
        nonce: intent.nonce,
        attestor: params.attestor,
        specHash: Buffer.from(params.specHash).toString("hex"),
        specUrl: url,
        sells: remainingOf(intent),
        judgeFee: params.judgeFee,
        net,
        feeBps: intent.feeBps,
        inputMint: intent.inputMint,
        expiresAt: intent.expiresAt,
        pays: whole[i] ?? null,
        ...(netPay === null ? { netPay: "0", payable: false } : { netPay, payable: true }),
        ...jobClaimOf(claims[i] ?? null),
        freezeAuthority: freezes[i] ?? null,
      };
    }),
  );
}

export async function jobPage(transport: Transport, wanted: PageWanted, terms: PayTerms, readable: Readable, options: PageOptions = {}): Promise<JobPage> {
  const { attestor, mint, unclaimed, owner, excludeOwners, minPay, after } = wanted;
  const mintsOf = mintsOnce(transport);
  const decimalsOf = decimalsOnce(transport, mintsOf);
  const { proofs, unreadable } = await openProofEscrows(transport, { attestor, mint, unclaimed, owner, excludeOwners }, Number.POSITIVE_INFINITY);
  const queue = (await minPaid(proofs, minPay, decimalsOf)).filter((proof) => after === undefined || newestFirst(keyOf(proof), after) > 0).sort((a, b) => newestFirst(keyOf(a), keyOf(b)));
  const history = historyOnce(transport);
  const { kept, more } = await scanned(history, queue, wanted, readable, options);
  return { jobs: await priced(transport, kept, terms, mintsOf, decimalsOf), unreadable, ...(more === undefined ? {} : { more }) };
}
