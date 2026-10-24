import type { Address } from "@solana/kit";
import {
  ANNOUNCEMENT_DISCRIMINATOR,
  checkAccountVersion,
  delivery,
  DELIVERY_BOOK_DISCRIMINATOR,
  deliveryBookAddress,
  getAnnouncementDecoder,
  getAnnouncementSize,
  getDeliveryBookDecoder,
  getRefutationDecoder,
  getRefutationSize,
  IntentStatus,
  NotAnEngineAccount,
  REFUTATION_DISCRIMINATOR,
} from "@intent-engine/core";
import { chainTime, createdAccount } from "./accounts.js";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { intentAt } from "./job-proofs.js";
import type { AccountMatch, Transport } from "./transport.js";

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
  state: delivery.AnnState;
  recipients: number;
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
};

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

export function announcementOf(address: Address, data: Uint8Array, lamports = 0n): AnnouncementView {
  const stored = getAnnouncementDecoder().decode(checkAccountVersion(data));
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
  const stored = getDeliveryBookDecoder().decode(checkAccountVersion(view.data));
  return { address, intent: stored.intent, payer: stored.payer, nextSeq: stored.nextSeq, live: stored.live };
}

async function listed(transport: Transport, match: AccountMatch): Promise<AnnouncementView[]> {
  if (transport.engineAccounts === undefined) {
    throw new AnnouncementsUnreadable();
  }
  const found = await transport.engineAccounts({ discriminator: ANNOUNCEMENT_DISCRIMINATOR, dataSize: getAnnouncementSize(), match: [match] });
  return found.map(({ address, data, lamports }) => announcementOf(address, data, lamports));
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
  const announcements = found.filter((announcement) => announcement.intent === intent).sort(bySeq);
  const closed = book === null || !open;
  const nextSeq = book?.nextSeq ?? 1n;
  const last = book === null ? announcements.reduce((max, { seq }) => (seq > max ? seq : max), 0n) : nextSeq - 1n;
  const missing = missingSeqs(announcements, last);
  return { intent, announcements, nextSeq, complete: !closed && everySeqOnce(announcements, nextSeq), closed, missing };
}

export async function announcementsTo(transport: Transport, attestor: Address): Promise<AnnouncementView[]> {
  return (await listed(transport, { offset: ATTESTOR_AT, address: attestor })).filter((announcement) => announcement.attestor === attestor).sort(byIntent);
}

export async function announcementsBy(transport: Transport, worker: Address): Promise<AnnouncementView[]> {
  return (await listed(transport, { offset: WORKER_AT, address: worker })).filter((announcement) => announcement.worker === worker).sort(byIntent);
}

export async function refutationsOf(transport: Transport, paid: Address): Promise<RefutationView[]> {
  if (transport.engineAccounts === undefined) {
    throw new AnnouncementsUnreadable();
  }
  const found = await transport.engineAccounts({
    discriminator: REFUTATION_DISCRIMINATOR,
    dataSize: getRefutationSize(),
    match: [{ offset: PAID_ANNOUNCEMENT_AT, address: paid }],
  });
  return found
    .map(({ address, data }) => {
      const stored = getRefutationDecoder().decode(checkAccountVersion(data));
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
    })
    .filter((refutation) => refutation.paidAnnouncement === paid)
    .sort((a, b) => (a.earlierSeq < b.earlierSeq ? -1 : a.earlierSeq > b.earlierSeq ? 1 : 0));
}
