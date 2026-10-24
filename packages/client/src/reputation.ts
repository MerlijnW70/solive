import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { feedbackMemo, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { HISTORY_LIMIT } from "./client-types.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { memoInstruction } from "./job-memos.js";
import { NotSettleable } from "./client-errors.js";
import { fundedBy, fundingLookup } from "./funding.js";
import { DELIVERY_PAGES, scan } from "./job-scan.js";
import { eventAuthority, eventsOf } from "./release-reads.js";
import type { Transport } from "./transport.js";
import { feedbackOf } from "./work-feedback.js";
import { announcedBy, historyCut, type RecordRead, recordOf, type WorkRecord } from "./work-records.js";

export type { RefutationRecord, RefutationStanding } from "./refutation-standing.js";
export type { WorkOutcome, WorkRecord, WorkRole } from "./work-records.js";

export type Earned = { mint: Address; amount: bigint };

export type Reputation = {
  wallet: Address;
  complete: boolean;
  reason?: string;
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

const SOL_DECIMALS = 9;

export const RECORD_READS = 4;

async function limited<T, R>(items: readonly T[], at: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const found: R[] = [];
  for (let start = 0; start < items.length; start += at) {
    found.push(...(await Promise.all(items.slice(start, start + at).map(read))));
  }
  return found;
}

const fundingUnchecked = (payer: Address): string => `the funding of the payer ${payer} could not be checked`;

export const counted = (record: WorkRecord): boolean =>
  record.outcome === "paid" && record.release !== undefined && !record.selfDealt && record.fundedByWorker !== "yes" && record.refutedBy === undefined;

export const solBacked = (record: WorkRecord): bigint => (record.mint === NATIVE_MINT ? (record.backed ?? 0n) : 0n) + (record.createBacked ?? 0n);

export async function reputationOf(transport: Transport, wallet: Address, options: ReputationOptions = {}): Promise<Reputation> {
  const { firstAvailableSlot } = transport;
  const fullLedger = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) === 0n;
  const pages = options.pages ?? DELIVERY_PAGES;
  const [scanned, by] = await Promise.all([scan(transport, wallet, { pages, covered: fullLedger }), eventAuthority()]);
  const works = announcedBy(wallet, scanned.transactions, by);
  const reads = { pages, history: options.history ?? HISTORY_LIMIT, by, covered: fullLedger };
  const read: RecordRead[] = await limited(works, RECORD_READS, (work) => recordOf(transport, wallet, work, reads));
  const reasons = [...(scanned.complete ? [] : [historyCut(wallet)]), ...read.flatMap(({ reasons: cut }) => cut)];
  const lookup = fundingLookup(transport, fullLedger);
  const records: WorkRecord[] = [];
  for (const { record } of read) {
    if (record.outcome !== "paid" || record.owner === undefined) {
      records.push(record);
      continue;
    }
    const funded = await fundedBy(lookup, record.owner, wallet);
    if (funded === "unknown") {
      reasons.push(fundingUnchecked(record.owner));
    }
    records.push({ ...record, fundedByWorker: funded });
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
    complete: reasons.length === 0 && records.every((r) => r.fundedByWorker !== "unknown"),
    ...(reasons[0] === undefined ? {} : { reason: reasons[0] }),
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

export type FeedbackInput = { owner: TransactionSigner; intent: IntentRef; score: number; note?: string };

export async function feedbackInstructions(transport: Transport, input: FeedbackInput, history = HISTORY_LIMIT): Promise<Instruction[]> {
  const intent = await intentAddress(input.intent);
  const memo = feedbackMemo({ intent, score: input.score, ...(input.note === undefined ? {} : { note: input.note }) });
  const transactions = await transport.engineTransactions(history, intent);
  const events = eventsOf(transactions, intent);
  const released = events.find(({ event }) => event.name === "IntentAttested" || event.name === "IntentSplit")?.event;
  if (released === undefined || (released.name !== "IntentAttested" && released.name !== "IntentSplit")) {
    throw new NotSettleable(intent, "no-release", "has no release among its recent transactions, so there is no work to give feedback on");
  }
  if (released.fields.owner !== input.owner.address) {
    throw new NotSettleable(intent, "not-owner", `was paid for by ${released.fields.owner}, and only that owner gives feedback on it`);
  }
  if (feedbackOf(transactions, intent, input.owner.address) !== undefined) {
    throw new NotSettleable(intent, "feedback-given", "already has its owner's feedback; the first one counts");
  }
  return [memoInstruction(input.owner, memo), getTransferSolInstruction({ source: input.owner, destination: intent, amount: 0n })];
}
