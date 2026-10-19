import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  feedbackMemo,
  DELIVERY_MEMO_PREFIX,
  findAssociatedTokenAddress,
  formatAmount,
  NATIVE_MINT,
  parseDeliveryMemo,
  parseFeedbackMemo,
  splitN,
} from "@intent-engine/core";
import { mintOf } from "./accounts.js";
import { loadCommittee } from "./client-committee.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { memoInstruction, recordedRelease } from "./job-memos.js";
import { NotSettleable } from "./client-errors.js";
import { type FundedBy, fundedBy, fundingLookup } from "./funding.js";
import { DELIVERY_PAGES, DELIVERY_SCAN, MEMOS_PER_TRANSACTION, scan, SIGNATURE_PAGE, signaturePage } from "./job-scan.js";
import { eventsOf, intentHistory, releaseOf, releaseThrough, splitClaim } from "./release-reads.js";
import { commitmentOf, openingsIn, saltCheckOf } from "./job-deliveries.js";
import { refutationIn } from "./delivery-openings.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type WorkOutcome = "paid" | "paid-other" | "refunded" | "open" | "unknown";

export type WorkRecord = {
  intent: Address;
  sha256: string;
  commitment: string;
  check: string;
  announced: Signature;
  slot: bigint;
  blockTime: bigint | null;
  outcome: WorkOutcome;
  refutedBy?: Signature;
  owner?: Address;
  attestor?: Address;
  committee?: Address[];
  mint?: Address;
  earned?: bigint;
  backed?: bigint;
  createBacked?: bigint;
  release?: Signature;
  selfDealt: boolean;
  fundedByWorker?: FundedBy;
  feedback?: number;
};

export type Earned = { mint: Address; amount: bigint };

export type Reputation = {
  wallet: Address;
  complete: boolean;
  announced: number;
  paid: number;
  refuted: number;
  selfDealt: number;
  fundedByWorker: number;
  fundingUnknown: number;
  paidVerified: number;
  payers: number;
  judges: number;
  committeeJudged: number;
  earned: Earned[];
  backed: Earned[];
  backedSol: string;
  feedback: { count: number; average: number | null };
  first: bigint | null;
  last: bigint | null;
  records: WorkRecord[];
};

export type ReputationOptions = { pages?: number; history?: number };

export const ORDER_PAGES = 2;

const SOL_DECIMALS = 9;

type Announced = { intent: Address; sha256: string; commitment: string; check: string; announced: Signature; slot: bigint; blockTime: bigint | null };

type Ranked = Announced & { rank: number };

function announcedWork(text: string): { key: string; intent: Address; sha256: string; commitment: string; check: string } | null {
  const memo = parseDeliveryMemo(text);
  return memo === null ? null : { key: `${memo.intent}:${memo.commitment}`, intent: memo.intent, sha256: "", commitment: memo.commitment, check: memo.check };
}

const older = (a: Ranked, b: Ranked): boolean => a.slot < b.slot || (a.slot === b.slot && a.rank > b.rank);

type Announcements = { works: Announced[]; notified: Address[] };

export const NOTIFIED_WALLETS = 2;

function notifiedBy(wallet: Address, intent: Address, transfers: readonly { from: Address; to: Address }[]): Address[] {
  const named = [...new Set(transfers.filter(({ from }) => from === wallet).map(({ to }) => to))];
  return named.slice(0, NOTIFIED_WALLETS).filter((to) => to !== intent && to !== wallet);
}

function announcedBy(wallet: Address, transactions: readonly EngineTransaction[]): Announcements[] {
  const found = new Map<string, Ranked & { notified: Address[] }>();
  for (const [rank, { signature, slot, blockTime, failed, memos, feePayer, transfers }] of transactions.entries()) {
    if (failed || feePayer !== wallet) {
      continue;
    }
    for (const work of (memos ?? []).slice(0, MEMOS_PER_TRANSACTION).map(announcedWork)) {
      if (work === null) {
        continue;
      }
      const { key, ...announced } = work;
      const next = { ...announced, announced: signature as Signature, slot, blockTime, rank, notified: notifiedBy(wallet, work.intent, transfers ?? []) };
      const held = found.get(key);
      if (held === undefined || older(next, held)) {
        found.set(key, next);
      }
    }
  }
  const byIntent = new Map<Address, (Ranked & { notified: Address[] })[]>();
  for (const work of found.values()) {
    byIntent.set(work.intent, [...(byIntent.get(work.intent) ?? []), work]);
  }
  return [...byIntent.values()].map((works) => {
    const sorted = works.sort((a, b) => (older(a, b) ? -1 : older(b, a) ? 1 : 0));
    return { works: sorted.map(({ rank: _, notified: __, ...work }) => work), notified: sorted[0]?.notified ?? [] };
  });
}

export const RECORD_READS = 4;

async function limited<T, R>(items: readonly T[], at: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const found: R[] = [];
  for (let start = 0; start < items.length; start += at) {
    found.push(...(await Promise.all(items.slice(start, start + at).map(read))));
  }
  return found;
}

function feedbackOf(transactions: readonly EngineTransaction[], intent: Address, owner: Address): number | undefined {
  const ordered = [...transactions].filter(({ failed }) => !failed).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  for (const { memos, memoSigners } of ordered) {
    for (const [i, text] of (memos ?? []).entries()) {
      const memo = parseFeedbackMemo(text);
      if (memo !== null && memo.intent === intent && memoSigners?.[i]?.includes(owner) === true) {
        return memo.score;
      }
    }
  }
  return undefined;
}

async function judgeOf(transport: Transport, attestor: Address): Promise<Address[] | undefined> {
  const committee = await loadCommittee(transport, attestor);
  return committee === null ? undefined : [...committee.members];
}

const orderIn = (newestFirst: readonly string[], announcement: string, release: string): boolean | null => {
  const at = newestFirst.indexOf(announcement);
  const released = newestFirst.indexOf(release);
  return at < 0 || released < 0 ? null : at > released;
};

export async function landedBefore(transport: Transport, attestor: Address, announcement: { slot: bigint; signature: string }, release: { slot: bigint; signature: string }): Promise<boolean | null> {
  if (announcement.slot !== release.slot) {
    return announcement.slot < release.slot;
  }
  const { signaturesOf } = transport;
  if (signaturesOf === undefined) {
    const listed = await transport.engineTransactions(DELIVERY_SCAN, attestor);
    return orderIn(listed.map(({ signature }) => signature), announcement.signature, release.signature);
  }
  let before = release.signature;
  for (let page = 1; page <= ORDER_PAGES; page++) {
    const { listed, last } = await signaturePage(transport, signaturesOf, attestor, SIGNATURE_PAGE, before);
    if (listed.some(({ signature }) => signature === announcement.signature)) {
      return true;
    }
    const oldest = listed[listed.length - 1];
    if (oldest === undefined || last || oldest.slot < announcement.slot) {
      return false;
    }
    before = oldest.signature;
  }
  return null;
}

async function recordOf(transport: Transport, wallet: Address, { works, notified }: Announcements, history: number): Promise<{ record: WorkRecord; complete: boolean }> {
  const first = works[0] as Announced;
  const intent = first.intent;
  const read = await intentHistory(transport, intent, history);
  const buried = read.complete || releaseOf(read.transactions, intent) !== undefined ? [] : await releaseThrough(transport, intent, notified, ORDER_PAGES, first.blockTime);
  const transactions = [...read.transactions, ...buried];
  const events = eventsOf(transactions, intent);
  const created = events.find(({ event }) => event.name === "IntentCreated")?.event;
  const released = releaseOf(transactions, intent);
  const refunded = events.some(({ event }) => event.name === "IntentCancelled" || event.name === "IntentExpired");
  let complete = read.complete;
  const owner = created?.name === "IntentCreated" ? created.fields.owner : released?.event.name === "IntentAttested" || released?.event.name === "IntentSplit" ? released.event.fields.owner : undefined;
  const payee = released?.event.name === "IntentAttested" ? released.event.fields.payee : undefined;
  const mint = created?.name === "IntentCreated" ? created.fields.inputMint : released?.transaction.tokens?.find(({ account }) => account === payee)?.mint;
  const createFee = created?.name === "IntentCreated" ? BigInt(created.fields.createFee) : undefined;
  if (released === undefined || (released.event.name !== "IntentAttested" && released.event.name !== "IntentSplit")) {
    const outcome: WorkOutcome = refunded ? "refunded" : "open";
    return { complete, record: { ...first, selfDealt: false, outcome, ...(owner === undefined ? {} : { owner }), ...(mint === undefined ? {} : { mint }) } };
  }
  const { event, transaction } = released;
  const attestor = event.fields.attestor;
  const committee = await judgeOf(transport, attestor);
  const selfDealt =
    event.fields.owner === wallet ||
    attestor === wallet ||
    event.fields.owner === attestor ||
    (committee !== undefined && (committee.includes(wallet) || committee.includes(event.fields.owner)));
  const recorded = recordedRelease(transactions, transaction, attestor);
  const commonOf = (work: Announced) => ({
    ...work,
    owner: event.fields.owner,
    attestor,
    ...(committee === undefined ? {} : { committee }),
    ...(mint === undefined ? {} : { mint }),
    release: transaction.signature as Signature,
    selfDealt,
  });
  const openings = openingsIn(transactions, new Set([intent]));
  const opensTo = (work: Announced): boolean => {
    const opened = openings.flatMap(({ opening }) => ("announcement" in opening && opening.announcement === work.announced ? [opening.salt] : []));
    const salts = [...(recorded?.salt === undefined ? [] : [recorded.salt]), ...opened];
    return recorded !== null && salts.some((salt) => saltCheckOf(salt) === work.check && commitmentOf(intent, wallet, salt, recorded.sha256) === work.commitment);
  };
  const work = works.find(opensTo);
  if (work === undefined || recorded === null) {
    return { complete, record: { ...commonOf(first), outcome: "paid-other" } };
  }
  const before = await landedBefore(transport, attestor, { slot: work.slot, signature: work.announced }, transaction);
  if (before !== true) {
    return { complete: complete && before === false, record: { ...commonOf(work), outcome: before === false ? "paid-other" : "unknown" } };
  }
  const common = { ...commonOf(work), sha256: recorded.sha256 };

  let earned: bigint | undefined;
  let credit = (fee: bigint): bigint => fee;
  if (event.name === "IntentAttested") {
    if (mint === undefined) {
      return { complete: false, record: { ...common, outcome: "unknown" } };
    }
    const { tokenProgram } = await mintOf(transport, mint);
    const own = await findAssociatedTokenAddress({ owner: wallet, mint, tokenProgram });
    earned = event.fields.payee === own ? event.fields.net : undefined;
  } else {
    const claim = splitClaim(transaction, intent);
    const at = claim?.recipients.indexOf(wallet) ?? -1;
    earned = claim === null || at < 0 ? undefined : splitN(event.fields.net, claim.weights)[at];
    if (claim !== null && at >= 0) {
      const weights = claim.weights;
      credit = (fee) => splitN(fee, weights)[at] ?? 0n;
    }
  }
  if (earned === undefined) {
    return { complete, record: { ...common, outcome: "paid-other" } };
  }
  const paidWallets = event.name === "IntentSplit" ? [...(splitClaim(transaction, intent)?.recipients ?? [wallet])] : [wallet];
  const createdAt = events.find(({ event: found }) => found.name === "IntentCreated")?.transaction.blockTime ?? null;
  const judged = { attestor, createdAt, to: transaction.slot };
  const refutation = await refutationIn(transport, transactions, { intent, slot: work.slot, signature: work.announced }, recorded.sha256, paidWallets, judged);
  complete &&= refutation.complete;
  const feedback = feedbackOf(transactions, intent, event.fields.owner);
  const backing = createFee === undefined ? {} : { backed: credit(event.fields.fee), createBacked: credit(createFee) };
  const refuted = refutation.refutedBy === null ? {} : { refutedBy: refutation.refutedBy };
  return { complete: complete && createFee !== undefined, record: { ...common, outcome: "paid", earned, ...backing, ...refuted, ...(feedback === undefined ? {} : { feedback }) } };
}

export const counted = (record: WorkRecord): boolean =>
  record.outcome === "paid" && !record.selfDealt && record.fundedByWorker !== "yes" && record.refutedBy === undefined;

export const solBacked = (record: WorkRecord): bigint => (record.mint === NATIVE_MINT ? (record.backed ?? 0n) : 0n) + (record.createBacked ?? 0n);

export async function reputationOf(transport: Transport, wallet: Address, options: ReputationOptions = {}): Promise<Reputation> {
  const { firstAvailableSlot } = transport;
  const fullLedger = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) === 0n;
  const scanned = await scan(transport, wallet, { memo: DELIVERY_MEMO_PREFIX, pages: options.pages ?? DELIVERY_PAGES, covered: fullLedger });
  const works = announcedBy(wallet, scanned.transactions);
  const read = await limited(works, RECORD_READS, (work) => recordOf(transport, wallet, work, options.history ?? HISTORY_LIMIT));
  const lookup = fundingLookup(transport, fullLedger);
  const records: WorkRecord[] = [];
  for (const { record } of read) {
    records.push(record.outcome === "paid" && record.owner !== undefined ? { ...record, fundedByWorker: await fundedBy(lookup, record.owner, wallet) } : record);
  }
  records.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const arm = records.filter((r) => r.outcome === "paid" && !r.selfDealt);
  const fair = records.filter(counted);
  const earned = new Map<Address, bigint>();
  for (const r of fair) {
    if (r.mint !== undefined && r.earned !== undefined) {
      earned.set(r.mint, (earned.get(r.mint) ?? 0n) + r.earned);
    }
  }
  const backed = new Map<Address, bigint>();
  let backedSol = 0n;
  for (const r of fair) {
    if (r.mint !== undefined && r.backed !== undefined && r.backed > 0n) {
      backed.set(r.mint, (backed.get(r.mint) ?? 0n) + r.backed);
    }
    backedSol += solBacked(r);
  }
  const scores = fair.flatMap((r) => (r.feedback === undefined ? [] : [r.feedback]));
  const times = records.flatMap((r) => (r.blockTime === null ? [] : [r.blockTime]));
  return {
    wallet,
    complete: scanned.complete && read.every(({ complete }) => complete) && records.every((r) => r.fundedByWorker !== "unknown"),
    announced: records.length,
    paid: fair.length,
    refuted: records.filter((r) => r.refutedBy !== undefined).length,
    selfDealt: records.filter((r) => r.outcome === "paid" && r.selfDealt).length,
    fundedByWorker: arm.filter((r) => r.fundedByWorker === "yes").length,
    fundingUnknown: arm.filter((r) => r.fundedByWorker === "unknown").length,
    paidVerified: fair.filter((r) => r.fundedByWorker === "no").length,
    payers: new Set(fair.map((r) => r.owner)).size,
    judges: new Set(fair.map((r) => r.attestor)).size,
    committeeJudged: fair.filter((r) => r.committee !== undefined).length,
    earned: [...earned].map(([mint, amount]) => ({ mint, amount })),
    backed: [...backed].map(([mint, amount]) => ({ mint, amount })),
    backedSol: formatAmount(backedSol, SOL_DECIMALS),
    feedback: { count: scores.length, average: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length },
    first: times.length === 0 ? null : times.reduce((a, b) => (a < b ? a : b)),
    last: times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b)),
    records,
  };
}

export type FeedbackInput = { owner: TransactionSigner; intent: Address; score: number; note?: string };

export async function feedbackInstructions(transport: Transport, input: FeedbackInput, history = HISTORY_LIMIT): Promise<Instruction[]> {
  const memo = feedbackMemo({ intent: input.intent, score: input.score, ...(input.note === undefined ? {} : { note: input.note }) });
  const transactions = await transport.engineTransactions(history, input.intent);
  const events = eventsOf(transactions, input.intent);
  const released = events.find(({ event }) => event.name === "IntentAttested" || event.name === "IntentSplit")?.event;
  if (released === undefined || (released.name !== "IntentAttested" && released.name !== "IntentSplit")) {
    throw new NotSettleable(input.intent, "has no release among its recent transactions, so there is no work to give feedback on");
  }
  if (released.fields.owner !== input.owner.address) {
    throw new NotSettleable(input.intent, `was paid for by ${released.fields.owner}, and only that owner gives feedback on it`);
  }
  if (feedbackOf(transactions, input.intent, input.owner.address) !== undefined) {
    throw new NotSettleable(input.intent, "already has its owner's feedback; the first one counts");
  }
  return [memoInstruction(input.owner, memo), getTransferSolInstruction({ source: input.owner, destination: input.intent, amount: 0n })];
}
