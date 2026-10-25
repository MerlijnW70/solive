import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { ANNOUNCEMENT_DISCRIMINATOR, decodeAnnouncementAccount, getAnnouncementSize, readAccounts, splitCommit, type UnreadableAccount } from "@intent-engine/core/internal";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { type AnnouncementView, announcementView, loadAnnouncement } from "./announcement-reads.js";
import { NoHeldShare } from "./client-errors.js";
import { intentAt } from "./job-proofs.js";
import { DELIVERY_PAGES, scan } from "./job-scan.js";
import { engineEvents, eventAuthority, settlementIn, splitClaim } from "./release-reads.js";
import type { AccountView, EngineTransaction, Transport } from "./transport.js";

export const ANNOUNCEMENT_STATE_AT = 292;
export const ANNOUNCEMENT_HELD_AT = 294;
export const PAID_STATE = 1;

export type HeldSplit = { recipients: Address[]; weights: number[] };

export type HeldShare = {
  wallet: Address;
  intent: Address;
  announcement: Address;
  index: number;
  amount: bigint;
  mint: Address;
  account: Address;
  capped: bigint;
  release: Signature;
  split: HeldSplit;
};

export type HeldShares = { wallet: Address; shares: HeldShare[]; complete: boolean; reasons: string[]; unreadable: UnreadableAccount[] };

export type HeldSharesOptions = { pages?: number };

export type HeldInRelease = { wallet: Address; account: Address; index: number; amount: bigint; announcement: Address };

export const heldBit = (held: number, index: number): boolean => index >= 0 && index < 8 && (held & (1 << index)) !== 0;

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

export function heldIn(release: EngineTransaction, by: Address, intent: Address): HeldInRelease[] {
  return engineEvents([release], by, intent).flatMap(({ event }) =>
    event.name === "ShareHeld" ? [{ wallet: event.fields.wallet, account: event.fields.account, index: event.fields.index, amount: event.fields.share, announcement: event.fields.announcement }] : [],
  );
}

export type HeldClaim = { announcement: Address; index: number; wallet: Address; to: Address; amount: bigint; signature: Signature };

export function heldClaimsIn(transactions: readonly EngineTransaction[], by: Address, intent: Address): HeldClaim[] {
  return engineEvents(transactions, by, intent).flatMap(({ event, transaction }) =>
    event.name === "HeldShareClaimed"
      ? [{ announcement: event.fields.announcement, index: event.fields.index, wallet: event.fields.wallet, to: event.fields.to, amount: event.fields.share, signature: transaction.signature as Signature }]
      : [],
  );
}

const TOKEN_ACCOUNT_LEN = 165;
const STATE_AT = 108;
const INITIALIZED = 1;
const ACCOUNT_TYPE = 2;
const IMMUTABLE_OWNER = 7;
const MEMO_TRANSFER = 8;
const CPI_GUARD = 11;
const ACCEPTED_EXTENSIONS: ReadonlySet<number> = new Set([IMMUTABLE_OWNER, MEMO_TRANSFER, CPI_GUARD]);

export function acceptsPayout(view: AccountView | null, tokenProgram: Address, mint: Address, wallet: Address): boolean {
  if (view === null || view.owner !== tokenProgram || view.data.length < TOKEN_ACCOUNT_LEN) {
    return false;
  }
  const { data } = view;
  const decoder = getAddressDecoder();
  if (decoder.decode(data.subarray(0, 32)) !== mint || decoder.decode(data.subarray(32, 64)) !== wallet || data[STATE_AT] !== INITIALIZED) {
    return false;
  }
  if (data.length === TOKEN_ACCOUNT_LEN) {
    return true;
  }
  if (data[TOKEN_ACCOUNT_LEN] !== ACCOUNT_TYPE) {
    return false;
  }
  const tlv = new DataView(data.buffer, data.byteOffset, data.length);
  for (let at = TOKEN_ACCOUNT_LEN + 1; at + 4 <= data.length; ) {
    const type = tlv.getUint16(at, true);
    const len = tlv.getUint16(at + 2, true);
    if (type === 0) {
      return true;
    }
    if (!ACCEPTED_EXTENSIONS.has(type) || at + 4 + len > data.length) {
      return false;
    }
    if (type === MEMO_TRANSFER && data[at + 4] !== 0) {
      return false;
    }
    at += 4 + len;
  }
  return true;
}

type Found = { shares: HeldShare[]; reasons: string[] };

export const releaseUnread = (announcement: Address): string => `the release of ${announcement} was not found in its history, so its held shares are not listed`;

export const heldSplitUnread = (announcement: Address): string => `the release of ${announcement} names no split matching the one the announcement records, so its held shares are not listed`;

async function releaseOfPaid(transport: Transport, view: AnnouncementView, by: Address, pages: number): Promise<EngineTransaction | null> {
  const settles = (transaction: EngineTransaction): boolean => {
    const settlement = settlementIn(transaction, by, view.intent);
    return settlement !== null && settlement.settled.name === "IntentSplit" && settlement.released.announcement === view.address;
  };
  const scanned = await scan(transport, view.address, { pages, until: settles });
  return scanned.transactions.find(settles) ?? null;
}

async function sharesOf(transport: Transport, view: AnnouncementView, wallet: Address, by: Address, pages: number): Promise<Found> {
  if (view.state !== "paid" || view.held === 0) {
    return { shares: [], reasons: [] };
  }
  const release = await releaseOfPaid(transport, view, by, pages);
  if (release === null) {
    return { shares: [], reasons: [releaseUnread(view.address)] };
  }
  const claim = splitClaim(release, view.intent);
  if (claim === null || !equal(await splitCommit([...claim.recipients], [...claim.weights]), view.splitHash)) {
    return { shares: [], reasons: [heldSplitUnread(view.address)] };
  }
  const held = heldIn(release, by, view.intent).filter(
    (share) => share.announcement === view.address && share.wallet === wallet && claim.recipients[share.index] === wallet && heldBit(view.held, share.index),
  );
  if (held.length === 0) {
    return { shares: [], reasons: [] };
  }
  const escrow = await intentAt(transport, view.intent);
  if (escrow === null) {
    return { shares: [], reasons: [] };
  }
  const split = { recipients: [...claim.recipients], weights: [...claim.weights] };
  return {
    shares: held.map((share) => ({
      wallet,
      intent: view.intent,
      announcement: view.address,
      index: share.index,
      amount: share.amount,
      mint: escrow.inputMint,
      account: share.account,
      capped: escrow.capped,
      release: release.signature as Signature,
      split,
    })),
    reasons: [],
  };
}

async function heldAnnouncements(transport: Transport): Promise<{ announcements: AnnouncementView[]; unreadable: UnreadableAccount[] }> {
  if (transport.engineAccounts === undefined) {
    throw new AnnouncementsUnreadable();
  }
  const found = await transport.engineAccounts({
    discriminator: ANNOUNCEMENT_DISCRIMINATOR,
    dataSize: getAnnouncementSize(),
    match: [{ offset: ANNOUNCEMENT_STATE_AT, bytes: Uint8Array.of(PAID_STATE) }],
  });
  const holding = found.filter(({ data }) => data[ANNOUNCEMENT_STATE_AT] === PAID_STATE && data[ANNOUNCEMENT_HELD_AT] !== 0);
  const { read, unreadable } = readAccounts(holding, decodeAnnouncementAccount);
  const lamports = new Map(holding.map(({ address, lamports: held }) => [address, held]));
  return { announcements: read.map(({ address, account }) => announcementView(address, account, lamports.get(address) ?? 0n)), unreadable };
}

const byIntent = (a: HeldShare, b: HeldShare): number =>
  a.intent === b.intent ? (a.announcement === b.announcement ? a.index - b.index : a.announcement < b.announcement ? -1 : 1) : a.intent < b.intent ? -1 : 1;

export async function heldSharesOf(transport: Transport, wallet: Address, options: HeldSharesOptions = {}): Promise<HeldShares> {
  const pages = options.pages ?? DELIVERY_PAGES;
  const [{ announcements, unreadable }, by] = await Promise.all([heldAnnouncements(transport), eventAuthority()]);
  const shares: HeldShare[] = [];
  const reasons: string[] = [];
  for (const view of announcements) {
    const found = await sharesOf(transport, view, wallet, by, pages);
    shares.push(...found.shares);
    reasons.push(...found.reasons);
  }
  return { wallet, shares: shares.sort(byIntent), complete: reasons.length === 0 && unreadable.length === 0, reasons, unreadable };
}

export async function heldShareAt(transport: Transport, announcement: Address, wallet: Address, index?: number): Promise<HeldShare> {
  const view = await loadAnnouncement(transport, announcement);
  if (view === null) {
    throw new NoHeldShare(announcement, wallet, "no-announcement", `${announcement} is no announcement on this cluster`);
  }
  if (view.state !== "paid" || view.held === 0) {
    throw new NoHeldShare(announcement, wallet, "not-held", `the announcement ${announcement} holds no share; it was paid at release or already claimed`);
  }
  const found = await sharesOf(transport, view, wallet, await eventAuthority(), DELIVERY_PAGES);
  const share = found.shares.find((candidate) => index === undefined || candidate.index === index);
  if (share !== undefined) {
    return share;
  }
  const [reason] = found.reasons;
  if (reason !== undefined) {
    throw new NoHeldShare(announcement, wallet, "release-unread", reason);
  }
  if ((await intentAt(transport, view.intent)) === null) {
    throw new NoHeldShare(announcement, wallet, "escrow-closed", `the escrow ${view.intent} is closed, so a share it held went back to its owner`);
  }
  throw new NoHeldShare(announcement, wallet, "not-held", `the announcement ${announcement} holds no share for ${wallet}${index === undefined ? "" : ` at index ${index}`}`);
}
