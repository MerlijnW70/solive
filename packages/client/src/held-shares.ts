import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { ANNOUNCEMENT_DISCRIMINATOR, decodeAnnouncementAccount, getAnnouncementSize, readAccounts, splitCommit, type UnreadableAccount } from "@intent-engine/core/internal";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { type AnnouncementView, announcementView, loadAnnouncement } from "./announcement-reads.js";
import { NoHeldShare } from "./client-errors.js";
import { intentAt } from "./job-proofs.js";
import { DELIVERY_PAGES, SIGNATURE_PAGE, scan, signaturePage } from "./job-scan.js";
import { engineEvents, eventAuthority, settlementIn, splitClaim } from "./release-reads.js";
import { type AccountView, type EngineTransaction, type ListedSignature, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const ANNOUNCEMENT_STATE_AT = 292;
export const ANNOUNCEMENT_HELD_AT = 294;
export const PAID_STATE = 1;
export const HELD_ANNOUNCEMENTS = 64;
export const HELD_READS = 16;
export const HELD_CONCURRENCY = 4;

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

export type HeldSharesOptions = { pages?: number; announcements?: number; reads?: number };

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
      ? [{ announcement: event.fields.announcement, index: event.fields.index, wallet: event.fields.wallet, to: event.fields.to, amount: event.fields.share, signature: transaction.signature }]
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

export const heldReadsSpent = (announcement: Address, reads: number): string =>
  `the history of ${announcement} needs more than ${reads} reads to find its release, so its held shares are not listed`;

export const heldPastLimit = (count: number, limit: number): string =>
  `${count} announcements holding shares past the first ${limit} were not read, so their held shares are not listed`;

type Budget = { history: Transport; reads: number; spent: () => boolean };

function budgeted(transport: Transport, reads: number): Budget {
  let left = reads;
  let short = false;
  const spend = (count: number): number => {
    const spent = Math.min(count, left);
    left -= spent;
    short ||= spent < count;
    return spent;
  };
  const { signaturesOf, transactionsOf } = transport;
  const overrides: Partial<Transport> = {
    engineTransactions: async (limit, of, memo) => {
      const allowed = spend(limit);
      return allowed === 0 ? [] : transport.engineTransactions(allowed, of, memo);
    },
    ...(signaturesOf === undefined
      ? {}
      : {
          signaturesOf: async (of: Address, limit: number, before?: string, until?: string) =>
            spend(1) === 0 ? [] : signaturesOf.call(transport, of, limit, before, until),
        }),
    ...(transactionsOf === undefined
      ? {}
      : {
          transactionsOf: async (listed: readonly ListedSignature[]) => {
            const allowed = spend(listed.length);
            return allowed === 0 ? [] : transactionsOf.call(transport, listed.slice(0, allowed));
          },
        }),
  };
  return { history: Object.assign(Object.create(transport) as Transport, overrides), reads, spent: () => short };
}

async function releaseOfPaid(history: Transport, view: AnnouncementView, by: Address, pages: number): Promise<EngineTransaction | null> {
  const settles = (transaction: EngineTransaction): boolean => {
    const settlement = settlementIn(transaction, by, view.intent);
    return settlement !== null && settlement.settled.name === "IntentSplit" && settlement.released.announcement === view.address;
  };
  const { signaturesOf, transactionsOf } = history;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    const scanned = await scan(history, view.address, { pages, until: settles });
    return scanned.transactions.find(settles) ?? null;
  }
  let before: string | undefined;
  for (let page = 1; page <= pages; page++) {
    const { listed, last } = await signaturePage(history, signaturesOf, view.address, SIGNATURE_PAGE, before);
    const candidates = listed.filter(({ failed, blockTime }) => !failed && (blockTime === null || blockTime === view.paidAt));
    for (let at = 0; at < candidates.length; at += TRANSACTION_FETCHES) {
      const found = (await transactionsOf.call(history, candidates.slice(at, at + TRANSACTION_FETCHES))).find(settles);
      if (found !== undefined) {
        return found;
      }
    }
    if (last || listed.some(({ blockTime }) => blockTime !== null && blockTime < view.paidAt)) {
      return null;
    }
    before = listed[listed.length - 1]?.signature;
  }
  return null;
}

async function sharesOf(transport: Transport, view: AnnouncementView, wallet: Address, by: Address, pages: number, budget?: Budget): Promise<Found> {
  if (view.state !== "paid" || view.held === 0) {
    return { shares: [], reasons: [] };
  }
  const release = await releaseOfPaid(budget?.history ?? transport, view, by, pages);
  if (release === null) {
    return { shares: [], reasons: [budget?.spent() === true ? heldReadsSpent(view.address, budget.reads) : releaseUnread(view.address)] };
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
      release: release.signature,
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

const ownFirst =
  (wallet: Address) =>
  (a: AnnouncementView, b: AnnouncementView): number => {
    if ((a.worker === wallet) !== (b.worker === wallet)) {
      return a.worker === wallet ? -1 : 1;
    }
    if (a.paidAt !== b.paidAt) {
      return a.paidAt > b.paidAt ? -1 : 1;
    }
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  };

async function inLanes<T, R>(items: readonly T[], lanes: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) {
      results[at] = await run(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  return results;
}

export async function heldSharesOf(transport: Transport, wallet: Address, options: HeldSharesOptions = {}): Promise<HeldShares> {
  const { pages = DELIVERY_PAGES, announcements: limit = HELD_ANNOUNCEMENTS, reads = HELD_READS } = options;
  const [{ announcements, unreadable }, by] = await Promise.all([heldAnnouncements(transport), eventAuthority()]);
  const read = [...announcements].sort(ownFirst(wallet)).slice(0, limit);
  const found = await inLanes(read, HELD_CONCURRENCY, async (view) => sharesOf(transport, view, wallet, by, pages, budgeted(transport, reads)));
  const shares = found.flatMap((one) => one.shares);
  const past = announcements.length - read.length;
  const reasons = [...found.flatMap((one) => one.reasons), ...(past > 0 ? [heldPastLimit(past, limit)] : [])];
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
