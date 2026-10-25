import type { Address, Signature } from "@solana/kit";
import { AccountVersionError, IntentStatus } from "@intent-engine/core";
import { splitN } from "@intent-engine/core/internal";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { loadAnnouncement, refutationsOf } from "./announcement-reads.js";
import { loadCommittee } from "./client-committee.js";
import type { FundedBy } from "./funding.js";
import { intentAt } from "./job-proofs.js";
import { scan } from "./job-scan.js";
import { type RefutationRecord, refutationRecord } from "./refutation-standing.js";
import { engineEvents, intentHistory, type Settlement, settlementIn, splitClaim } from "./release-reads.js";
import type { EngineTransaction, Transport } from "./transport.js";
import { feedbackOf } from "./work-feedback.js";

export type WorkOutcome = "paid" | "paid-other" | "refunded" | "open" | "unknown";

export type WorkRole = "announcer" | "co-author";

export type WorkRecord = {
  intent: Address;
  sha256: string;
  commitment: string;
  announcement: Address;
  seq: bigint;
  role: WorkRole;
  announced: Signature;
  slot: bigint;
  blockTime: bigint | null;
  outcome: WorkOutcome;
  refutedBy?: Address;
  refutations: RefutationRecord[];
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

export type Announced = { intent: Address; announcement: Address; seq: bigint; commitment: string; announced: Signature; slot: bigint; blockTime: bigint | null };

export type RecordRead = { record: WorkRecord; reasons: string[] };

export type RecordReads = { pages: number; history: number; by: Address; covered: () => Promise<boolean> };

export const historyCut = (of: Address): string => `the history of ${of} was not read to its start`;

export const unreadableAccount = (address: Address, error: unknown): string => `the account ${address} could not be read: ${error instanceof Error ? error.message : String(error)}`;

const hexOf = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function announcedBy(wallet: Address, transactions: readonly EngineTransaction[], by: Address): Announced[][] {
  const found = new Map<Address, Announced>();
  for (const { event, transaction } of engineEvents(transactions, by)) {
    if (event.name === "DeliveryAnnounced" && event.fields.worker === wallet && !found.has(event.fields.announcement)) {
      const { intent, announcement, seq, commitment } = event.fields;
      found.set(announcement, { intent, announcement, seq, commitment: hexOf(commitment), announced: transaction.signature as Signature, slot: transaction.slot, blockTime: transaction.blockTime });
    }
  }
  const byIntent = new Map<Address, Announced[]>();
  for (const work of found.values()) {
    byIntent.set(work.intent, [...(byIntent.get(work.intent) ?? []), work]);
  }
  return [...byIntent.values()].map((works) => works.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)));
}

type Found<T> = { found: T; reasons: string[] };

async function ownRelease(transport: Transport, wallet: Address, work: Announced, reads: RecordReads): Promise<Found<Settlement | null>> {
  let account;
  try {
    account = await loadAnnouncement(transport, work.announcement);
  } catch (error) {
    return { found: null, reasons: [unreadableAccount(work.announcement, error)] };
  }
  if (account !== null && account.state === "announced") {
    return { found: null, reasons: [] };
  }
  const settles = (transaction: EngineTransaction): boolean => {
    const settlement = settlementIn(transaction, reads.by, work.intent);
    return settlement !== null && settlement.released.announcement === work.announcement && settlement.released.worker === wallet;
  };
  const scanned = await scan(transport, work.announcement, { pages: reads.pages, until: settles, covered: reads.covered });
  const release = scanned.transactions.find(settles);
  if (release !== undefined) {
    return { found: settlementIn(release, reads.by, work.intent), reasons: [] };
  }
  return { found: null, reasons: scanned.complete && account === null ? [] : [historyCut(work.announcement)] };
}

async function judgeOf(transport: Transport, attestor: Address): Promise<Address[] | undefined> {
  const committee = await loadCommittee(transport, attestor);
  return committee === null ? undefined : [...committee.members];
}

async function refutationsAgainst(transport: Transport, announcement: Address): Promise<Found<RefutationRecord[]>> {
  try {
    const found = await refutationsOf(transport, announcement);
    return { found: await Promise.all(found.map((refutation) => refutationRecord(transport, refutation))), reasons: [] };
  } catch (error) {
    if (error instanceof AnnouncementsUnreadable) {
      return { found: [], reasons: [error.message] };
    }
    if (error instanceof AccountVersionError) {
      return { found: [], reasons: [`a refutation of ${announcement} could not be read: ${error.message}`] };
    }
    throw error;
  }
}

type Escrow = { transactions: EngineTransaction[]; complete: boolean; inputMint?: Address };

async function paidRecord(transport: Transport, wallet: Address, base: WorkRecord, settlement: Settlement, role: WorkRole, escrow: Escrow, by: Address): Promise<RecordRead> {
  const { settled, released, transaction } = settlement;
  const { intent } = base;
  const events = engineEvents(escrow.transactions, by, intent);
  const created = events.find(({ event }) => event.name === "IntentCreated")?.event;
  const createFee = created?.name === "IntentCreated" ? BigInt(created.fields.createFee) : undefined;
  const mint = created?.name === "IntentCreated" ? created.fields.inputMint : (escrow.inputMint ?? transaction.tokens?.[0]?.mint);
  const { owner, attestor } = settled.fields;
  const committee = await judgeOf(transport, attestor);
  const selfDealt = owner === wallet || attestor === wallet || owner === attestor || (committee !== undefined && (committee.includes(wallet) || committee.includes(owner)));
  const common: WorkRecord = {
    ...base,
    announcement: released.announcement,
    seq: released.seq,
    role,
    sha256: hexOf(released.delivered),
    owner,
    attestor,
    ...(committee === undefined ? {} : { committee }),
    ...(mint === undefined ? {} : { mint }),
    release: transaction.signature as Signature,
    selfDealt,
  };
  let earned: bigint | undefined;
  let credit = (fee: bigint): bigint => fee;
  if (settled.name === "IntentAttested") {
    earned = role === "announcer" && released.worker === wallet ? settled.fields.net : undefined;
  } else {
    const claim = splitClaim(transaction, intent);
    if (claim === null) {
      return { record: { ...common, outcome: "unknown" }, reasons: [`the split release ${transaction.signature} names no readable claim`] };
    }
    const at = claim.recipients.indexOf(wallet);
    earned = at < 0 ? undefined : splitN(settled.fields.net, claim.weights)[at];
    credit = (fee) => (at < 0 ? 0n : (splitN(fee, claim.weights)[at] ?? 0n));
  }
  if (earned === undefined) {
    return { record: { ...common, outcome: "paid-other" }, reasons: [] };
  }
  if (mint === undefined) {
    return { record: { ...common, outcome: "unknown" }, reasons: [historyCut(intent)] };
  }
  const reasons = createFee === undefined ? [historyCut(intent)] : [];
  const refutations = role === "announcer" ? await refutationsAgainst(transport, released.announcement) : { found: [], reasons: [] };
  const substantiated = refutations.found.find(({ standing }) => standing === "substantiated");
  const feedback = feedbackOf(escrow.transactions, intent, owner);
  return {
    record: {
      ...common,
      outcome: "paid",
      earned,
      refutations: refutations.found,
      ...(substantiated === undefined ? {} : { refutedBy: substantiated.refutation }),
      ...(createFee === undefined ? {} : { backed: credit(settled.fields.fee), createBacked: credit(createFee) }),
      ...(feedback === undefined ? {} : { feedback }),
    },
    reasons: [...reasons, ...refutations.reasons],
  };
}

function escrowSettlement(escrow: Escrow, intent: Address, by: Address): Settlement | null {
  for (const transaction of escrow.transactions) {
    const settlement = settlementIn(transaction, by, intent);
    if (settlement !== null) {
      return settlement;
    }
  }
  return null;
}

export async function recordOf(transport: Transport, wallet: Address, works: readonly Announced[], reads: RecordReads): Promise<RecordRead> {
  const first = works[0] as Announced;
  const { intent } = first;
  const base: WorkRecord = { ...first, sha256: "", role: "announcer", outcome: "unknown", selfDealt: false, refutations: [] };
  let held;
  try {
    held = await intentAt(transport, intent);
  } catch (error) {
    return { record: base, reasons: [unreadableAccount(intent, error)] };
  }
  if (held !== null && held.status === IntentStatus.Open) {
    return { record: { ...base, outcome: "open" }, reasons: [] };
  }
  if (held !== null && (held.status === IntentStatus.Cancelled || held.status === IntentStatus.Expired)) {
    return { record: { ...base, outcome: "refunded" }, reasons: [] };
  }
  const reasons: string[] = [];
  let own: Settlement | null = null;
  for (const work of works) {
    const read = await ownRelease(transport, wallet, work, reads);
    reasons.push(...read.reasons);
    if (read.found !== null) {
      own = read.found;
      break;
    }
  }
  const history = await intentHistory(transport, intent, reads.history);
  const escrow: Escrow = { ...history, ...(held === null ? {} : { inputMint: held.inputMint }) };
  const released = own ?? escrowSettlement(escrow, intent, reads.by);
  if (released !== null) {
    const mine = works.some(({ announcement }) => announcement === released.released.announcement) && released.released.worker === wallet;
    const paid = await paidRecord(transport, wallet, base, released, mine ? "announcer" : "co-author", escrow, reads.by);
    if (!mine && paid.record.outcome !== "paid") {
      return { record: { ...paid.record, announcement: first.announcement, seq: first.seq, role: "announcer", sha256: "" }, reasons: paid.reasons };
    }
    return paid;
  }
  const refunded = engineEvents(history.transactions, reads.by, intent).some(({ event }) => event.name === "IntentCancelled" || event.name === "IntentExpired");
  if (refunded) {
    return { record: { ...base, outcome: "refunded" }, reasons: [] };
  }
  return { record: base, reasons: [...reasons, history.complete ? `escrow ${intent} shows no release, cancel or expiry` : historyCut(intent)] };
}
