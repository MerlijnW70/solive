import type { Address } from "@solana/kit";
import {
  decodeEvent,
  FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getFillAttestedSplitInstructionDataDecoder,
  getIntentSize,
  type Intent,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  parseReleaseMemo,
} from "@intent-engine/core";
import {
  createdAtOf,
  DELIVERY_SCAN,
  engineCalls,
  type EngineTransaction,
  type ListedSignature,
  historyCovers,
  intentAt,
  parseFollowUpMemo,
  recordedDelivery,
  scan,
  SIGNATURE_PAGE,
  TRANSACTION_FETCHES,
  transactionAt,
  type Transport,
} from "@intent-engine/client";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { pairOf } from "./fills.js";

export const releaseNotOf = (signature: string, intent: string) =>
  `the transaction ${signature} is not a release of the escrow ${intent}; pass the release signature that ${tool("wallet_attest")}, ${tool("wallet_attest_split")} or judge returned`;

export const releaseUnread = (signature: string) =>
  `the RPC node could not return the transaction ${signature}, so the release cannot be read from it; call again in a few seconds, or leave release out to search the escrow's history`;

export const HISTORY_PAGES = 10;

const createdIn = (tx: EngineTransaction, intent: Address): boolean =>
  !tx.failed &&
  tx.emitted.some((data) => {
    const event = decodeEvent(data);
    return event?.name === "IntentCreated" && (event.fields as Record<string, unknown>)["intent"] === intent;
  });

export async function escrowHistory(transport: Transport, intent: Address): Promise<EngineTransaction[]> {
  const floor = await createdAtOf(transport, intent);
  return (await scan(transport, intent, { floor, pages: HISTORY_PAGES, until: (tx) => createdIn(tx, intent) })).transactions;
}

export async function creatorOf(transport: Transport, intent: Address): Promise<{ owner: Address; nonce: bigint } | null> {
  for (const tx of await escrowHistory(transport, intent)) {
    for (const event of tx.failed ? [] : tx.emitted.map(decodeEvent)) {
      const fields = event?.fields as Record<string, unknown> | undefined;
      if (event?.name === "IntentCreated" && fields?.["intent"] === intent) {
        return { owner: fields["owner"] as Address, nonce: fields["nonce"] as bigint };
      }
    }
  }
  return null;
}

export const RELEASE_PAGES = 50;

export const RELEASE_UNKNOWN = `the escrow's history could not be read in full and no release was found in what was read, so whether it was released is unknown: it is longer than the ${HISTORY_PAGES} pages read, the RPC node's ledger does not reach back to its creation, or the node could not return some of its transactions yet; a release that carries a memo is found past this cap, one without a memo is not, so pass release, the signature the release returned, to read it directly`;

type ReleaseEvent = NonNullable<ReturnType<typeof decodeEvent>>;

export type ReleaseLookup = {
  release: { tx: EngineTransaction; event: ReleaseEvent } | null;
  transactions: EngineTransaction[];
  complete: boolean;
  bound: boolean;
  creation?: EngineTransaction | null;
  later?: boolean;
  lagged?: boolean;
};

export const LIFECYCLE_FETCHES = SIGNATURE_PAGE;

function releaseEventIn(tx: EngineTransaction, intent: Address): ReleaseEvent | null {
  if (tx.failed) {
    return null;
  }
  for (const event of tx.emitted.map(decodeEvent)) {
    if (event !== null && (event.name === "IntentAttested" || event.name === "IntentSplit") && (event.fields as Record<string, unknown>)["intent"] === intent) {
      return event;
    }
  }
  return null;
}

export const outlives = (held: Intent, release: EngineTransaction, creation: EngineTransaction | null | undefined): boolean =>
  held.status !== IntentStatus.Filled ||
  (release.blockTime !== null && release.blockTime < held.createdAt) ||
  (creation !== null && creation !== undefined && creation.blockTime !== null && creation.blockTime < held.createdAt);

const LISTED_MEMO_LENGTH = /^\[\d+\] /;

const listedMemos = (memo: string | null): string[] => (memo === null ? [] : memo.split("; ").map((part) => part.replace(LISTED_MEMO_LENGTH, "")));

const namesRelease = (texts: readonly string[], release: string): boolean => texts.some((text) => parseFollowUpMemo(text)?.release === release);

const unreadIn = (transactions: readonly EngineTransaction[]): boolean => transactions.some((tx) => tx.unread === true);

async function fetched(transport: Transport, listed: readonly ListedSignature[]): Promise<EngineTransaction[]> {
  const { transactionsOf } = transport;
  const found: EngineTransaction[] = [];
  for (let at = 0; transactionsOf !== undefined && at < listed.length; at += TRANSACTION_FETCHES) {
    found.push(...(await transactionsOf.call(transport, listed.slice(at, at + TRANSACTION_FETCHES))));
  }
  return found;
}

async function markedRelease(transport: Transport, intent: Address, floor: bigint | null): Promise<ReleaseLookup | null> {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    return null;
  }
  const followUps = new Map<string, ListedSignature[]>();
  const newer: ListedSignature[] = [];
  let before: string | undefined;
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const listed = await signaturesOf.call(transport, intent, SIGNATURE_PAGE, before);
    const within = listed.filter((entry) => floor === null || entry.blockTime === null || entry.blockTime >= floor);
    const candidates: ListedSignature[] = [];
    for (const entry of within) {
      if (entry.failed) {
        continue;
      }
      const memos = listedMemos(entry.memo);
      for (const named of memos.map(parseFollowUpMemo)) {
        if (named !== null) {
          followUps.set(named.release, [...(followUps.get(named.release) ?? []), entry]);
        }
      }
      if (followUps.has(entry.signature) || memos.some((text) => parseReleaseMemo(text) !== null)) {
        candidates.push(entry);
      }
    }
    for (let at = 0; at < candidates.length; at += TRANSACTION_FETCHES) {
      for (const tx of await transactionsOf.call(transport, candidates.slice(at, at + TRANSACTION_FETCHES))) {
        const event = releaseEventIn(tx, intent);
        if (event === null) {
          continue;
        }
        const since = [...newer, ...within.slice(0, within.findIndex((entry) => entry.signature === tx.signature))].filter((entry) => !entry.failed);
        if (floor !== null || since.length > LIFECYCLE_FETCHES) {
          const recorded = await fetched(transport, followUps.get(tx.signature) ?? []);
          const bound = floor !== null;
          return { release: { tx, event }, transactions: [...recorded, tx], complete: bound && !unreadIn(recorded), bound };
        }
        const read = await fetched(transport, since);
        if (read.some((later) => createdIn(later, intent))) {
          return null;
        }
        const bound = read.length === since.length && !unreadIn(read);
        return { release: { tx, event }, transactions: [...read, tx], complete: bound, bound };
      }
    }
    newer.push(...within);
    before = listed[listed.length - 1]?.signature;
    if (within.length < listed.length || before === undefined) {
      return null;
    }
  }
  return null;
}

export async function releaseLookup(transport: Transport, intent: Address): Promise<ReleaseLookup> {
  const held = await intentAt(transport, intent);
  const floor = held?.createdAt ?? null;
  const ours = (tx: EngineTransaction) => held === null || !outlives(held, tx, null);
  const marked = await markedRelease(transport, intent, floor);
  if (marked !== null && marked.release !== null && ours(marked.release.tx)) {
    return marked;
  }
  const covered = () => historyCovers(transport, intent, floor ?? undefined);
  const scanned = await scan(transport, intent, { floor, pages: HISTORY_PAGES, until: (tx) => createdIn(tx, intent), covered });
  const at = scanned.transactions.findIndex((tx) => releaseEventIn(tx, intent) !== null);
  const tx = scanned.transactions[at];
  const event = tx === undefined ? null : releaseEventIn(tx, intent);
  if (tx !== undefined && event !== null && ours(tx)) {
    return { release: { tx, event }, transactions: scanned.transactions, complete: !unreadIn(scanned.transactions.slice(0, at)), bound: true };
  }
  return { release: null, transactions: scanned.transactions, complete: scanned.complete && !unreadIn(scanned.transactions), bound: true };
}

export type AroundRelease = { followUps: EngineTransaction[]; creation: EngineTransaction | null; later: boolean; complete: boolean; lagged?: boolean };

const atOrBefore = (entry: ListedSignature, release: EngineTransaction): boolean =>
  entry.slot <= release.slot || (entry.blockTime !== null && release.blockTime !== null && entry.blockTime <= release.blockTime);

export async function aroundRelease(transport: Transport, intent: Address, release: EngineTransaction): Promise<AroundRelease> {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    const found = await transport.engineTransactions(DELIVERY_SCAN, intent);
    const at = found.findIndex((tx) => tx.signature === release.signature);
    const newer = at < 0 ? found : found.slice(0, at);
    const followUps = newer.filter((tx) => tx.unread === true || namesRelease(tx.memos ?? [], release.signature));
    return {
      followUps,
      creation: at < 0 ? null : (found.slice(at + 1).find((tx) => createdIn(tx, intent)) ?? null),
      later: newer.some((tx) => createdIn(tx, intent)),
      complete: at >= 0 && !unreadIn(followUps),
    };
  }
  const held = await intentAt(transport, intent);
  const current = held !== null && release.blockTime !== null && !outlives(held, release, null);
  const candidate = (entry: ListedSignature): boolean =>
    !entry.failed && (current ? entry.blockTime !== null && entry.blockTime === held?.createdAt : atOrBefore(entry, release));
  const named: ListedSignature[] = [];
  let reached = false;
  let creation: EngineTransaction | null = null;
  let settled = false;
  let capped = false;
  let lagged = false;
  let spent = 0;
  let before: string | undefined;
  for (let page = 1; page <= RELEASE_PAGES && !(reached && settled); page++) {
    const listed = await signaturesOf.call(transport, intent, SIGNATURE_PAGE, before);
    let older = listed;
    if (!reached) {
      const end = listed.findIndex((entry) => entry.signature === release.signature || entry.slot < release.slot);
      named.push(...(end < 0 ? listed : listed.slice(0, end)).filter((entry) => !entry.failed && namesRelease(listedMemos(entry.memo), release.signature)));
      reached = end >= 0;
      older = end < 0 ? [] : listed.slice(listed[end]?.signature === release.signature ? end + 1 : end);
    }
    const wanted = settled ? [] : older.filter(candidate);
    for (let at = 0; at < wanted.length && !settled; at += TRANSACTION_FETCHES) {
      if (spent >= LIFECYCLE_FETCHES) {
        capped = !current;
        settled = true;
        break;
      }
      const batch = wanted.slice(at, at + Math.min(TRANSACTION_FETCHES, LIFECYCLE_FETCHES - spent));
      spent += batch.length;
      for (const tx of await transactionsOf.call(transport, batch)) {
        if (tx.unread === true || createdIn(tx, intent)) {
          creation = tx.unread === true ? null : tx;
          lagged = tx.unread === true && !current;
          settled = true;
          break;
        }
      }
    }
    before = listed[listed.length - 1]?.signature;
    if (before === undefined || listed.length < SIGNATURE_PAGE) {
      break;
    }
  }
  const followUps = await fetched(transport, named);
  return { followUps, creation, later: false, complete: reached && !capped && !lagged && !unreadIn(followUps), ...(lagged ? { lagged } : {}) };
}

export async function namedRelease(transport: Transport, intent: Address, signature: string): Promise<ReleaseLookup> {
  const tx = await transactionAt(transport, signature, intent);
  if (tx === null || tx.unread === true) {
    throw new AgentRefusal("ReleaseUnread", releaseUnread(signature));
  }
  const event = releaseEventIn(tx, intent);
  if (event === null) {
    throw new AgentRefusal("NotARelease", releaseNotOf(signature, intent));
  }
  const attestor = (event.fields as Record<string, unknown>)["attestor"] as Address;
  const around = await aroundRelease(transport, intent, tx);
  const inline = recordedDelivery([], tx, attestor) !== null;
  return {
    release: { tx, event },
    transactions: [...(inline ? [] : around.followUps), tx],
    complete: inline || around.complete,
    bound: true,
    creation: around.creation,
    later: around.later,
    ...(around.lagged === true ? { lagged: true } : {}),
  };
}

export function releasedMint(tx: EngineTransaction, intent: Address, payee?: Address): Address | undefined {
  const tokens = tx.tokens ?? [];
  return (tokens.find((held) => held.owner === intent) ?? tokens.find((held) => payee !== undefined && held.account === payee))?.mint;
}

export function createdMint(transactions: readonly EngineTransaction[], intent: Address): Address | undefined {
  for (const tx of transactions) {
    for (const event of tx.emitted.map(decodeEvent)) {
      const fields = (event?.fields ?? {}) as Record<string, unknown>;
      if (event?.name === "IntentCreated" && fields["intent"] === intent) {
        return fields["inputMint"] as Address;
      }
    }
  }
  return undefined;
}

export async function heldMint(transport: Transport, intent: Address): Promise<Address | undefined> {
  const view = await transport.getAccount(intent);
  return view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() ? undefined : pairOf(view.data)?.inputMint;
}

export const SPLIT_INTENT_ACCOUNT = 2;

const startsWith = (data: Uint8Array, discriminator: ArrayLike<number>): boolean =>
  data.length >= discriminator.length && Array.from(discriminator).every((b, i) => data[i] === b);

const splitDecoders = [
  { discriminator: FILL_ATTESTED_SPLIT_DISCRIMINATOR, decode: (data: Uint8Array) => getFillAttestedSplitInstructionDataDecoder().decode(data).claim },
  {
    discriminator: FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
    decode: (data: Uint8Array) => getFillAttestedSplitCommitteeInstructionDataDecoder().decode(data).claim,
  },
];

const splitDecoderOf = (data: Uint8Array) => splitDecoders.find(({ discriminator }) => startsWith(data, discriminator));

const isSplit = (data: Uint8Array): boolean => splitDecoderOf(data) !== undefined;

export function splitRecipients(tx: EngineTransaction, intent?: Address): Address[] | null {
  const calls = engineCalls(tx).filter(({ data, accounts }) => isSplit(data) && (intent === undefined || accounts?.[SPLIT_INTENT_ACCOUNT] === intent));
  const call = calls.find(({ inner }) => !inner) ?? calls[0];
  if (call === undefined) {
    return null;
  }
  try {
    return splitDecoderOf(call.data)?.decode(call.data).recipients ?? null;
  } catch {
    return null;
  }
}
