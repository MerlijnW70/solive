import { type Address, getAddressEncoder, type ReadonlyUint8Array } from "@solana/kit";
import { type AnnState, IntentStatus, NotAnEngineAccount } from "@intent-engine/core";
import {
  type Announcement,
  ANNOUNCEMENT_DISCRIMINATOR,
  decodeAnnouncementAccount,
  decodeDeliveryBookAccount,
  decodeRefutationAccount,
  delivery,
  DELIVERY_BOOK_DISCRIMINATOR,
  deliveryBookAddress,
  getAnnouncementSize,
  getRefutationSize,
  readAccounts,
  REFUTATION_DISCRIMINATOR,
  type Refutation,
  type UnreadableAccount,
} from "@intent-engine/core/internal";
import { chainTime, createdAccount } from "./accounts.js";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { intentAt } from "./job-proofs.js";
import type { EngineAccount, Transport } from "./transport.js";

export const INTENT_AT = 8;
export const WORKER_AT = 40;
export const ATTESTOR_AT = 72;
export const PAID_ANNOUNCEMENT_AT = 72;

export type AnnouncementView = {
  address: Address;
  intent: Address;
  worker: Address;
  attestor: Address;
  payer: Address;
  commitment: Uint8Array;
  delivered: Uint8Array;
  splitHash: Uint8Array;
  seq: bigint;
  slot: bigint;
  announcedAt: bigint;
  expiresAt: bigint;
  paidAt: bigint;
  salt: Uint8Array;
  state: AnnState;
  recipients: number;
  held: number;
  blob: Uint8Array;
  lamports: bigint;
};

export type DeliveryBookView = { address: Address; intent: Address; payer: Address; nextSeq: bigint; live: bigint };

export type AnnouncementList = {
  intent: Address;
  announcements: AnnouncementView[];
  nextSeq: bigint;
  complete: boolean;
  closed: boolean;
  missing: bigint[];
  unreadable: UnreadableAccount[];
};

export type AnnouncementScan = { announcements: AnnouncementView[]; unreadable: UnreadableAccount[] };

export type RefutationView = {
  address: Address;
  intent: Address;
  attestor: Address;
  paidAnnouncement: Address;
  earlierAnnouncement: Address;
  paidWorker: Address;
  earlierWorker: Address;
  delivered: Uint8Array;
  earlierCommitment: Uint8Array;
  esk: Uint8Array;
  salt: Uint8Array;
  blob: Uint8Array;
  paidSeq: bigint;
  earlierSeq: bigint;
};

export type RefutationScan = { refutations: RefutationView[]; unreadable: UnreadableAccount[] };

export function announcementOf(address: Address, data: Uint8Array, lamports = 0n): AnnouncementView {
  return announcementView(address, decodeAnnouncementAccount(data), lamports);
}

export function announcementView(address: Address, stored: Announcement, lamports: bigint): AnnouncementView {
  return {
    address,
    intent: stored.intent,
    worker: stored.worker,
    attestor: stored.attestor,
    payer: stored.payer,
    commitment: Uint8Array.from(stored.commitment),
    delivered: Uint8Array.from(stored.delivered),
    splitHash: Uint8Array.from(stored.splitHash),
    seq: stored.seq,
    slot: stored.slot,
    announcedAt: stored.announcedAt,
    expiresAt: stored.expiresAt,
    paidAt: stored.paidAt,
    salt: Uint8Array.from(stored.salt),
    state: delivery.decodeAnnState(stored.state),
    recipients: stored.recipients,
    held: stored.held,
    blob: Uint8Array.from(stored.blob.slice(0, stored.blobLen)),
    lamports,
  };
}

const tagged = (data: Uint8Array, head: ArrayLike<number>): boolean => Array.from(head).every((b, i) => data[i] === b);

export async function loadAnnouncement(transport: Transport, address: Address): Promise<AnnouncementView | null> {
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (!tagged(view.data, ANNOUNCEMENT_DISCRIMINATOR) || view.data.length !== getAnnouncementSize()) {
    throw new NotAnEngineAccount(address, `${address} is not an engine announcement`);
  }
  return announcementOf(address, view.data, view.lamports);
}

export async function loadDeliveryBook(transport: Transport, intent: Address): Promise<DeliveryBookView | null> {
  const address = await deliveryBookAddress(intent);
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (!tagged(view.data, DELIVERY_BOOK_DISCRIMINATOR)) {
    throw new NotAnEngineAccount(address, `${address} is not an engine delivery book`);
  }
  const stored = decodeDeliveryBookAccount(view.data);
  return { address, intent: stored.intent, payer: stored.payer, nextSeq: stored.nextSeq, live: stored.live };
}

type Field = { offset: number; address: Address };

const holds = (data: Uint8Array, { offset, address }: Field): boolean => {
  const bytes = getAddressEncoder().encode(address);
  return data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);
};

async function engineAccountsWith(transport: Transport, discriminator: ReadonlyUint8Array, dataSize: number, field: Field): Promise<EngineAccount[]> {
  if (transport.engineAccounts === undefined) {
    throw new AnnouncementsUnreadable();
  }
  const found = await transport.engineAccounts({ discriminator, dataSize, match: [field] });
  return found.filter(({ data }) => holds(data, field));
}

async function listed(transport: Transport, field: Field): Promise<AnnouncementScan> {
  const found = await engineAccountsWith(transport, ANNOUNCEMENT_DISCRIMINATOR, getAnnouncementSize(), field);
  const lamports = new Map(found.map(({ address, lamports: held }) => [address, held]));
  const { read, unreadable } = readAccounts(found, decodeAnnouncementAccount);
  return { announcements: read.map(({ address, account }) => announcementView(address, account, lamports.get(address) ?? 0n)), unreadable };
}

const bySeq = (a: AnnouncementView, b: AnnouncementView): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.address < b.address ? -1 : 1);

const byIntent = (a: AnnouncementView, b: AnnouncementView): number => (a.intent === b.intent ? bySeq(a, b) : a.intent < b.intent ? -1 : 1);

export const MISSING_SHOWN = 16;

function missingSeqs(announcements: readonly AnnouncementView[], last: bigint): bigint[] {
  const seqs = new Set(announcements.map(({ seq }) => seq));
  const missing: bigint[] = [];
  for (let seq = 1n; seq <= last && missing.length < MISSING_SHOWN; seq += 1n) {
    if (!seqs.has(seq)) {
      missing.push(seq);
    }
  }
  return missing;
}

function everySeqOnce(announcements: readonly AnnouncementView[], nextSeq: bigint): boolean {
  const seqs = new Set(announcements.map(({ seq }) => seq));
  return seqs.size === announcements.length && BigInt(announcements.length) === nextSeq - 1n && announcements.every(({ seq }) => seq >= 1n && seq < nextSeq);
}

async function escrowOpen(transport: Transport, intent: Address): Promise<boolean> {
  const [held, now] = await Promise.all([intentAt(transport, intent), chainTime(transport)]);
  return held !== null && held.status === IntentStatus.Open && now < held.expiresAt;
}

export async function announcementsOf(transport: Transport, intent: Address): Promise<AnnouncementList> {
  const [book, found, open] = await Promise.all([loadDeliveryBook(transport, intent), listed(transport, { offset: INTENT_AT, address: intent }), escrowOpen(transport, intent)]);
  const announcements = found.announcements.sort(bySeq);
  const { unreadable } = found;
  const closed = !open;
  const nextSeq = book?.nextSeq ?? 1n;
  const last = book === null ? announcements.reduce((max, { seq }) => (seq > max ? seq : max), 0n) : nextSeq - 1n;
  const missing = missingSeqs(announcements, last);
  const complete = !closed && unreadable.length === 0 && everySeqOnce(announcements, nextSeq);
  return { intent, announcements, nextSeq, complete, closed, missing, unreadable };
}

export async function announcementsIn(transport: Transport, intent: Address): Promise<AnnouncementScan> {
  const { announcements, unreadable } = await listed(transport, { offset: INTENT_AT, address: intent });
  return { announcements: announcements.sort(bySeq), unreadable };
}

export async function announcementsTo(transport: Transport, attestor: Address): Promise<AnnouncementScan> {
  const { announcements, unreadable } = await listed(transport, { offset: ATTESTOR_AT, address: attestor });
  return { announcements: announcements.sort(byIntent), unreadable };
}

export async function announcementsBy(transport: Transport, worker: Address): Promise<AnnouncementScan> {
  const { announcements, unreadable } = await listed(transport, { offset: WORKER_AT, address: worker });
  return { announcements: announcements.sort(byIntent), unreadable };
}

function refutationView(address: Address, stored: Refutation): RefutationView {
  return {
    address,
    intent: stored.intent,
    attestor: stored.attestor,
    paidAnnouncement: stored.paidAnnouncement,
    earlierAnnouncement: stored.earlierAnnouncement,
    paidWorker: stored.paidWorker,
    earlierWorker: stored.earlierWorker,
    delivered: Uint8Array.from(stored.delivered),
    earlierCommitment: Uint8Array.from(stored.earlierCommitment),
    esk: Uint8Array.from(stored.esk),
    salt: Uint8Array.from(stored.salt),
    blob: Uint8Array.from(stored.blob.slice(0, stored.blobLen)),
    paidSeq: stored.paidSeq,
    earlierSeq: stored.earlierSeq,
  };
}

export async function refutationsOf(transport: Transport, paid: Address): Promise<RefutationScan> {
  const found = await engineAccountsWith(transport, REFUTATION_DISCRIMINATOR, getRefutationSize(), { offset: PAID_ANNOUNCEMENT_AT, address: paid });
  const { read, unreadable } = readAccounts(found, decodeRefutationAccount);
  const refutations = read
    .map(({ address, account }) => refutationView(address, account))
    .sort((a, b) => (a.earlierSeq < b.earlierSeq ? -1 : a.earlierSeq > b.earlierSeq ? 1 : 0));
  return { refutations, unreadable };
}
