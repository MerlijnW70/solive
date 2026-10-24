import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  decodeEvent,
  type EngineEvent,
  feedbackMemo,
  findAssociatedTokenAddress,
  formatAmount,
  NATIVE_MINT,
  parseFeedbackMemo,
  splitN,
} from "@intent-engine/core";
import { mintOf } from "./accounts.js";
import { loadCommittee } from "./client-committee.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { refutationsOf } from "./announcement-reads.js";
import { memoInstruction } from "./job-memos.js";
import { NotSettleable } from "./client-errors.js";
import { type FundedBy, fundedBy, fundingLookup } from "./funding.js";
import { DELIVERY_PAGES, DELIVERY_SCAN, scan, SIGNATURE_PAGE, signaturePage } from "./job-scan.js";
import { eventsOf, intentHistory, releasedDelivery, releaseOf, releaseThrough, splitClaim } from "./release-reads.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type WorkOutcome = "paid" | "paid-other" | "refunded" | "open" | "unknown";

export type WorkRecord = {
  intent: Address;
  sha256: string;
  commitment: string;
  announcement: Address;
  announced: Signature;
  slot: bigint;
  blockTime: bigint | null;
  outcome: WorkOutcome;
  refutedBy?: Address;
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

type Announced = { intent: Address; sha256: string; commitment: string; announcement: Address; announced: Signature; slot: bigint; blockTime: bigint | null };

const hexOf = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const announcedIn = (wallet: Address, emitted: readonly Uint8Array[]) =>
  emitted.flatMap((data) => {
    const event = decodeEvent(data) as EngineEvent | null;
    return event?.name === "DeliveryAnnounced" && event.fields.worker === wallet ? [event.fields] : [];
  });

type Announcements = { works: Announced[] };

function announcedBy(wallet: Address, transactions: readonly EngineTransaction[]): Announcements[] {
  const found = new Map<Address, Announced>();
  for (const { signature, slot, blockTime, failed, emitted } of transactions) {
    for (const fields of failed ? [] : announcedIn(wallet, emitted)) {
      found.set(fields.announcement, {
        intent: fields.intent,
        sha256: "",
        commitment: hexOf(fields.commitment),
        announcement: fields.announcement,
        announced: signature as Signature,
        slot,
        blockTime,
      });
    }
  }
  const byIntent = new Map<Address, Announced[]>();
  for (const work of found.values()) {
    byIntent.set(work.intent, [...(byIntent.get(work.intent) ?? []), work]);
  }
  return [...byIntent.values()].map((works) => ({ works: works.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)) }));
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

async function refutedOf(transport: Transport, announcement: Address): Promise<{ refutedBy?: Address; complete: boolean }> {
  try {
    const [first] = await refutationsOf(transport, announcement);
    return first === undefined ? { complete: true } : { refutedBy: first.address, complete: true };
  } catch (error) {
    if (error instanceof AnnouncementsUnreadable) {
      return { complete: false };
    }
    throw error;
  }
}

async function recordOf(transport: Transport, wallet: Address, { works }: Announcements, history: number): Promise<{ record: WorkRecord; complete: boolean }> {
  const first = works[0] as Announced;
  const intent = first.intent;
  const read = await intentHistory(transport, intent, history);
  const buried = read.complete || releaseOf(read.transactions, intent) !== undefined ? [] : await releaseThrough(transport, intent, works.map(({ announcement }) => announcement), ORDER_PAGES, first.blockTime);
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
  const delivered = releasedDelivery(transaction, intent);
  const commonOf = (work: Announced) => ({
    ...work,
    owner: event.fields.owner,
    attestor,
    ...(committee === undefined ? {} : { committee }),
    ...(mint === undefined ? {} : { mint }),
    release: transaction.signature as Signature,
    selfDealt,
  });
  const cosigned = event.name === "IntentSplit" && splitClaim(transaction, intent)?.recipients.includes(wallet) === true;
  const work = works.find(({ announcement }) => announcement === delivered?.announcement) ?? (cosigned ? first : undefined);
  if (work === undefined || delivered === null) {
    return { complete, record: { ...commonOf(first), outcome: "paid-other" } };
  }
  const common = { ...commonOf(work), sha256: delivered.sha256 };

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
  const refutation = await refutedOf(transport, delivered.announcement);
  complete &&= refutation.complete;
  const feedback = feedbackOf(transactions, intent, event.fields.owner);
  const backing = createFee === undefined ? {} : { backed: credit(event.fields.fee), createBacked: credit(createFee) };
  const refuted = refutation.refutedBy === undefined ? {} : { refutedBy: refutation.refutedBy };
  return { complete: complete && createFee !== undefined, record: { ...common, outcome: "paid", earned, ...backing, ...refuted, ...(feedback === undefined ? {} : { feedback }) } };
}

export const counted = (record: WorkRecord): boolean =>
  record.outcome === "paid" && !record.selfDealt && record.fundedByWorker !== "yes" && record.refutedBy === undefined;

export const solBacked = (record: WorkRecord): bigint => (record.mint === NATIVE_MINT ? (record.backed ?? 0n) : 0n) + (record.createBacked ?? 0n);

export async function reputationOf(transport: Transport, wallet: Address, options: ReputationOptions = {}): Promise<Reputation> {
  const { firstAvailableSlot } = transport;
  const fullLedger = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) === 0n;
  const scanned = await scan(transport, wallet, { pages: options.pages ?? DELIVERY_PAGES, covered: fullLedger });
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
