import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  decodeEvent,
  feedbackMemo,
  DELIVERY_MEMO_PREFIX,
  type EngineEvent,
  FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  findAssociatedTokenAddress,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getFillAttestedSplitInstructionDataDecoder,
  parseDeliveryMemo,
  parseFeedbackMemo,
  splitN,
} from "@intent-engine/core";
import { mintOf } from "./accounts.js";
import { loadCommittee } from "./client-committee.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { memoInstruction, recordedDelivery } from "./job-memos.js";
import { NotSettleable } from "./client-errors.js";
import { engineCalls } from "./job-origins.js";
import { DELIVERY_PAGES, MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type WorkOutcome = "paid" | "paid-other" | "refunded" | "open" | "unknown";

export type WorkRecord = {
  intent: Address;
  sha256: string;
  announced: Signature;
  slot: bigint;
  blockTime: bigint | null;
  outcome: WorkOutcome;
  owner?: Address;
  attestor?: Address;
  committee?: Address[];
  mint?: Address;
  earned?: bigint;
  release?: Signature;
  selfDealt: boolean;
  feedback?: number;
};

export type Earned = { mint: Address; amount: bigint };

export type Reputation = {
  wallet: Address;
  complete: boolean;
  announced: number;
  paid: number;
  selfDealt: number;
  payers: number;
  judges: number;
  committeeJudged: number;
  earned: Earned[];
  feedback: { count: number; average: number | null };
  first: bigint | null;
  last: bigint | null;
  records: WorkRecord[];
};

export type ReputationOptions = { pages?: number; history?: number };

const SPLIT_INTENT_ACCOUNT = 2;

const startsWith = (data: Uint8Array, head: ArrayLike<number>): boolean =>
  data.length >= head.length && Array.from(head).every((b, i) => data[i] === b);

function splitClaim(release: EngineTransaction, intent: Address) {
  for (const { data, accounts } of engineCalls(release)) {
    if (accounts?.[SPLIT_INTENT_ACCOUNT] !== intent) {
      continue;
    }
    try {
      if (startsWith(data, FILL_ATTESTED_SPLIT_DISCRIMINATOR)) {
        return getFillAttestedSplitInstructionDataDecoder().decode(data).claim;
      }
      if (startsWith(data, FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR)) {
        return getFillAttestedSplitCommitteeInstructionDataDecoder().decode(data).claim;
      }
    } catch {
      continue;
    }
  }
  return null;
}

type Announced = { intent: Address; sha256: string; announced: Signature; slot: bigint; blockTime: bigint | null };

function announcedBy(wallet: Address, transactions: readonly EngineTransaction[]): Announced[] {
  const found = new Map<string, Announced>();
  for (const { signature, slot, blockTime, failed, memos, feePayer } of transactions) {
    if (failed || feePayer !== wallet) {
      continue;
    }
    for (const memo of (memos ?? []).slice(0, MEMOS_PER_TRANSACTION).map(parseDeliveryMemo)) {
      if (memo === null) {
        continue;
      }
      const key = `${memo.intent}:${memo.sha256}`;
      const held = found.get(key);
      if (held === undefined || slot < held.slot || (slot === held.slot && signature < held.announced)) {
        found.set(key, { intent: memo.intent, sha256: memo.sha256, announced: signature as Signature, slot, blockTime });
      }
    }
  }
  return [...found.values()];
}

type Read = { event: EngineEvent; transaction: EngineTransaction };

function eventsOf(transactions: readonly EngineTransaction[], intent: Address): Read[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap((transaction) =>
      transaction.emitted
        .map((data) => decodeEvent(data) as EngineEvent | null)
        .filter((event): event is EngineEvent => event !== null && "intent" in event.fields && event.fields.intent === intent)
        .map((event) => ({ event, transaction })),
    );
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

async function recordOf(transport: Transport, wallet: Address, work: Announced, history: number): Promise<{ record: WorkRecord; complete: boolean }> {
  const transactions = await transport.engineTransactions(history, work.intent);
  const events = eventsOf(transactions, work.intent);
  const created = events.find(({ event }) => event.name === "IntentCreated")?.event;
  const released = events.find(({ event }) => event.name === "IntentAttested" || event.name === "IntentSplit");
  const refunded = events.some(({ event }) => event.name === "IntentCancelled" || event.name === "IntentExpired");
  const complete = created !== undefined || transactions.length < history;
  const base = { ...work, selfDealt: false };
  const owner = created?.name === "IntentCreated" ? created.fields.owner : released?.event.name === "IntentAttested" || released?.event.name === "IntentSplit" ? released.event.fields.owner : undefined;
  const mint = created?.name === "IntentCreated" ? created.fields.inputMint : undefined;
  if (released === undefined || (released.event.name !== "IntentAttested" && released.event.name !== "IntentSplit")) {
    const outcome: WorkOutcome = refunded ? "refunded" : "open";
    return { complete, record: { ...base, outcome, ...(owner === undefined ? {} : { owner }), ...(mint === undefined ? {} : { mint }) } };
  }
  const { event, transaction } = released;
  const attestor = event.fields.attestor;
  const committee = await judgeOf(transport, attestor);
  const selfDealt =
    event.fields.owner === wallet ||
    attestor === wallet ||
    event.fields.owner === attestor ||
    (committee !== undefined && (committee.includes(wallet) || committee.includes(event.fields.owner)));
  const recorded = recordedDelivery(transactions, transaction, attestor);
  const common = {
    ...base,
    owner: event.fields.owner,
    attestor,
    ...(committee === undefined ? {} : { committee }),
    ...(mint === undefined ? {} : { mint }),
    release: transaction.signature as Signature,
    selfDealt,
  };
  if (recorded !== work.sha256) {
    return { complete, record: { ...common, outcome: "paid-other" } };
  }
  let earned: bigint | undefined;
  if (event.name === "IntentAttested") {
    if (mint === undefined) {
      return { complete: false, record: { ...common, outcome: "unknown" } };
    }
    const { tokenProgram } = await mintOf(transport, mint);
    const own = await findAssociatedTokenAddress({ owner: wallet, mint, tokenProgram });
    earned = event.fields.payee === own ? event.fields.net : undefined;
  } else {
    const claim = splitClaim(transaction, work.intent);
    const at = claim?.recipients.indexOf(wallet) ?? -1;
    earned = claim === null || at < 0 ? undefined : splitN(event.fields.net, claim.weights)[at];
  }
  if (earned === undefined) {
    return { complete, record: { ...common, outcome: "paid-other" } };
  }
  const feedback = feedbackOf(transactions, work.intent, event.fields.owner);
  return { complete, record: { ...common, outcome: "paid", earned, ...(feedback === undefined ? {} : { feedback }) } };
}

export async function reputationOf(transport: Transport, wallet: Address, options: ReputationOptions = {}): Promise<Reputation> {
  const { firstAvailableSlot } = transport;
  const fullLedger = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) === 0n;
  const scanned = await scan(transport, wallet, { memo: DELIVERY_MEMO_PREFIX, pages: options.pages ?? DELIVERY_PAGES, covered: fullLedger });
  const works = announcedBy(wallet, scanned.transactions);
  const read = await Promise.all(works.map((work) => recordOf(transport, wallet, work, options.history ?? HISTORY_LIMIT)));
  const records = read.map(({ record }) => record).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  const fair = records.filter((r) => r.outcome === "paid" && !r.selfDealt);
  const earned = new Map<Address, bigint>();
  for (const r of fair) {
    if (r.mint !== undefined && r.earned !== undefined) {
      earned.set(r.mint, (earned.get(r.mint) ?? 0n) + r.earned);
    }
  }
  const scores = fair.flatMap((r) => (r.feedback === undefined ? [] : [r.feedback]));
  const times = records.flatMap((r) => (r.blockTime === null ? [] : [r.blockTime]));
  return {
    wallet,
    complete: scanned.complete && read.every(({ complete }) => complete),
    announced: records.length,
    paid: fair.length,
    selfDealt: records.filter((r) => r.outcome === "paid" && r.selfDealt).length,
    payers: new Set(fair.map((r) => r.owner)).size,
    judges: new Set(fair.map((r) => r.attestor)).size,
    committeeJudged: fair.filter((r) => r.committee !== undefined).length,
    earned: [...earned].map(([mint, amount]) => ({ mint, amount })),
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
