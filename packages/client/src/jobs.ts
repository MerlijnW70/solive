import { createHash } from "node:crypto";
import { AccountRole, type AccountSignerMeta, type Address, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  type AttestedResultParams,
  decodeEvent,
  decodeParams,
  deliveryMemo,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  type Intent,
  IntentStatus,
  Kind,
  DELIVERY_MEMO_PREFIX,
  parseDeliveryMemo,
  parseSpecMemo,
  remainingOf,
  SPEC_MEMO_PREFIX,
} from "@intent-engine/core";
import { chainTime, createdAccount } from "./accounts.js";
import { type EngineTransaction, type ListedSignature, MEMO_PROGRAM_ADDRESS, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const JOBS_LIMIT = 50;
export const SPEC_SCAN = 10;
export const DELIVERY_SCAN = 100;
export const DELIVERY_PAGES = 10;
export const SIGNATURE_PAGE = 1000;
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsfY";
export const PUBLIC_GENESIS_HASHES: ReadonlySet<string> = new Set([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH]);
export const MEMOS_PER_TRANSACTION = 8;
export const MAX_SPEC_BYTES = 1_048_576;
export const SPEC_TIMEOUT_MS = 10_000;

export type Job = {
  intent: Address;
  owner: Address;
  nonce: bigint;
  attestor: Address;
  specHash: string;
  specUrl: string | null;
  sells: bigint;
  judgeFee: bigint;
  inputMint: Address;
  expiresAt: bigint;
};

export type Spec = { url: string; text: string; sha256: string; matches: boolean };

export type DeliverInput = { worker: TransactionSigner; intent: Address; sha256: string; url: string };

export type Delivery = {
  intent: Address;
  worker: Address;
  sha256: string;
  url: string;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
};

export type DeliveryRecord = { deliveries: Delivery[]; complete: boolean };

export type Scan = { transactions: EngineTransaction[]; complete: boolean };

export type ScanOptions = {
  floor?: bigint | null;
  memo?: string;
  pages?: number;
  until?: (transaction: EngineTransaction) => boolean;
};

export type Announcement = { sha256: string; first: Delivery; copies: number };

export type SpecFetch = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<Response>;

export class NotDeliverable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotDeliverable";
    this.intent = intent;
  }
}

export class SpecUnreadable extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`the spec at ${url} ${reason}`);
    this.name = "SpecUnreadable";
    this.url = url;
  }
}

type Proof = { address: Address; intent: Intent; params: AttestedResultParams };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function proofOf(address: Address, intent: Intent): Proof | null {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  return params.kind === Kind.AttestedResult && params.specHash.some((b) => b !== 0) ? { address, intent, params } : null;
}

async function intentAt(transport: Transport, address: Address): Promise<Intent | null> {
  const view = await createdAccount(transport, address);
  const tag = getIntentDiscriminatorBytes();
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)) {
    return null;
  }
  return getIntentDecoder().decode(view.data);
}

async function proofAt(transport: Transport, address: Address): Promise<Proof | null> {
  const intent = await intentAt(transport, address);
  return intent === null ? null : proofOf(address, intent);
}

export async function createdAtOf(transport: Transport, address: Address): Promise<bigint | null> {
  return (await intentAt(transport, address))?.createdAt ?? null;
}

const memoMatches = (memo: string | undefined, texts: readonly string[]): boolean => memo === undefined || texts.some((text) => text.includes(memo));

const reaches = (floor: bigint | null) => ({ blockTime }: { blockTime: bigint | null }): boolean => floor === null || blockTime === null || blockTime >= floor;

async function fallbackScan(
  transport: Transport,
  of: Address,
  floor: bigint | null,
  memo: string | undefined,
  until?: (transaction: EngineTransaction) => boolean,
): Promise<Scan> {
  const found = await transport.engineTransactions(DELIVERY_SCAN, of);
  const within = found.filter(reaches(floor));
  const transactions: EngineTransaction[] = [];
  for (const transaction of within) {
    if (transaction.failed || !memoMatches(memo, transaction.memos ?? [])) {
      continue;
    }
    transactions.push(transaction);
    if (until?.(transaction) === true) {
      return { transactions, complete: true };
    }
  }
  return { transactions, complete: found.length < DELIVERY_SCAN || within.length < found.length };
}

export async function scan(transport: Transport, of: Address, options: ScanOptions = {}): Promise<Scan> {
  const { floor = null, memo, pages = DELIVERY_PAGES, until } = options;
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    return fallbackScan(transport, of, floor, memo, until);
  }
  const transactions: EngineTransaction[] = [];
  let before: string | undefined;
  for (let page = 0; page < pages; page++) {
    const listed = await signaturesOf.call(transport, of, SIGNATURE_PAGE, before);
    if (listed.length === 0) {
      return { transactions, complete: true };
    }
    const within = listed.filter(reaches(floor));
    const wanted = within.filter((entry: ListedSignature) => !entry.failed && memoMatches(memo, entry.memo === null ? [] : [entry.memo]));
    for (let at = 0; at < wanted.length; at += TRANSACTION_FETCHES) {
      for (const transaction of await transactionsOf.call(transport, wanted.slice(at, at + TRANSACTION_FETCHES))) {
        transactions.push(transaction);
        if (until?.(transaction) === true) {
          return { transactions, complete: true };
        }
      }
    }
    if (within.length < listed.length) {
      return { transactions, complete: true };
    }
    before = listed[listed.length - 1]?.signature;
  }
  return { transactions, complete: false };
}

export async function openProofEscrows(transport: Transport, attestor?: Address, limit: number = JOBS_LIMIT): Promise<Proof[]> {
  const [accounts, now] = await Promise.all([transport.intents(), chainTime(transport)]);
  return accounts
    .map(({ address, data }) => proofOf(address, getIntentDecoder().decode(data)))
    .filter(
      (proof): proof is Proof =>
        proof !== null &&
        proof.intent.status === IntentStatus.Open &&
        proof.intent.expiresAt > now &&
        (attestor === undefined || proof.params.attestor === attestor),
    )
    .sort((a, b) => (a.intent.expiresAt === b.intent.expiresAt ? 0 : a.intent.expiresAt > b.intent.expiresAt ? -1 : 1))
    .slice(0, limit);
}

const createdIn = (emitted: readonly Uint8Array[], intent: Address): boolean =>
  emitted.some((data) => {
    const event = decodeEvent(data);
    return event?.name === "IntentCreated" && "intent" in event.fields && event.fields.intent === intent;
  });

export async function specUrlOf(transport: Transport, intent: Address, createdAt?: bigint): Promise<string | null> {
  const floor = createdAt ?? (await proofAt(transport, intent))?.intent.createdAt ?? null;
  const created = (transaction: EngineTransaction) => !transaction.failed && createdIn(transaction.emitted, intent);
  const { transactions } = await scan(transport, intent, { floor, memo: SPEC_MEMO_PREFIX, until: created });
  const tx = transactions.find(created);
  if (tx === undefined) {
    return null;
  }
  const urls = new Set(
    (tx.memos ?? [])
      .slice(0, MEMOS_PER_TRANSACTION)
      .map(parseSpecMemo)
      .flatMap((memo) => (memo === null ? [] : [memo.url])),
  );
  return urls.size === 1 ? ([...urls][0] ?? null) : null;
}

export async function jobsOf(transport: Transport, attestor?: Address): Promise<Job[]> {
  const proofs = await openProofEscrows(transport, attestor);
  const urls: (string | null)[] = [];
  for (let at = 0; at < proofs.length; at += TRANSACTION_FETCHES) {
    urls.push(...(await Promise.all(proofs.slice(at, at + TRANSACTION_FETCHES).map(({ address, intent }) => specUrlOf(transport, address, intent.createdAt)))));
  }
  return proofs.map(({ address, intent, params }, i) => ({
    intent: address,
    owner: intent.owner,
    nonce: intent.nonce,
    attestor: params.attestor,
    specHash: hex(params.specHash),
    specUrl: urls[i] ?? null,
    sells: remainingOf(intent),
    judgeFee: params.judgeFee,
    inputMint: intent.inputMint,
    expiresAt: intent.expiresAt,
  }));
}

async function discarded(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function bounded(response: Response, url: string): Promise<Uint8Array> {
  if (!response.ok) {
    await discarded(response);
    throw new SpecUnreadable(url, `answered ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SPEC_BYTES) {
    await discarded(response);
    throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader?.read(); next !== undefined && next.done !== true; next = await reader?.read()) {
    size += next.value.length;
    if (size > MAX_SPEC_BYTES) {
      await reader?.cancel();
      throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export async function readSpec(transport: Transport, get: SpecFetch, intent: Address): Promise<Spec | null> {
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    return null;
  }
  const url = await specUrlOf(transport, intent, proof.intent.createdAt);
  if (url === null) {
    return null;
  }
  if (new URL(url).protocol === "http:" && PUBLIC_GENESIS_HASHES.has(await transport.genesisHash())) {
    throw new SpecUnreadable(url, "is a plain http url, which a spec on a public cluster may not use");
  }
  const bytes = await bounded(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) }), url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { url, text: new TextDecoder().decode(bytes), sha256, matches: sha256 === hex(proof.params.specHash) };
}

export function memoInstruction(signer: TransactionSigner, text: string): Instruction {
  const meta: AccountSignerMeta = { address: signer.address, role: AccountRole.READONLY_SIGNER, signer };
  return { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [meta], data: new TextEncoder().encode(text) };
}

export async function deliveryInstructions(transport: Transport, input: DeliverInput): Promise<{ attestor: Address; instructions: Instruction[] }> {
  const { worker, intent } = input;
  const memo = deliveryMemo({ intent, sha256: input.sha256, url: input.url });
  const [proof, now] = await Promise.all([proofAt(transport, intent), chainTime(transport)]);
  if (proof === null) {
    throw new NotDeliverable(intent, "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  if (proof.intent.status !== IntentStatus.Open || proof.intent.expiresAt <= now) {
    throw new NotDeliverable(intent, "is no longer open");
  }
  const attestor = proof.params.attestor;
  return {
    attestor,
    instructions: [memoInstruction(worker, memo), getTransferSolInstruction({ source: worker, destination: attestor, amount: 0n })],
  };
}

export async function deliveryRecord(transport: Transport, judge: Address, intent?: Address): Promise<DeliveryRecord> {
  let proofs: Proof[];
  if (intent === undefined) {
    proofs = await openProofEscrows(transport, judge, Number.POSITIVE_INFINITY);
  } else {
    const proof = await proofAt(transport, intent);
    proofs = proof !== null && proof.params.attestor === judge ? [proof] : [];
  }
  const [oldest] = proofs;
  if (oldest === undefined) {
    return { deliveries: [], complete: true };
  }
  const judged: ReadonlySet<Address> = new Set(proofs.map(({ address }) => address));
  const floor = proofs.reduce((low, { intent: held }) => (held.createdAt < low ? held.createdAt : low), oldest.intent.createdAt);
  const { transactions, complete } = await scan(transport, judge, { floor, memo: DELIVERY_MEMO_PREFIX });
  const deliveries = transactions.flatMap(({ signature, slot, blockTime, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? [])
          .slice(0, MEMOS_PER_TRANSACTION)
          .map(parseDeliveryMemo)
          .flatMap((memo) =>
            memo === null || !judged.has(memo.intent)
              ? []
              : [{ ...memo, worker: feePayer, signature: signature as Signature, slot, blockTime }],
          ),
  );
  return { deliveries, complete: complete && !transactions.some(({ unread }) => unread === true) };
}

export async function deliveriesOf(transport: Transport, judge: Address, intent?: Address): Promise<Delivery[]> {
  return (await deliveryRecord(transport, judge, intent)).deliveries;
}

const earlier = (a: Delivery, b: Delivery): boolean => a.slot < b.slot || (a.slot === b.slot && a.signature < b.signature);

export function firstDelivery(deliveries: readonly Delivery[], sha256: string): Delivery | null {
  let first: Delivery | null = null;
  for (const delivery of deliveries) {
    if (delivery.sha256 === sha256 && (first === null || earlier(delivery, first))) {
      first = delivery;
    }
  }
  return first;
}

export function announcements(deliveries: readonly Delivery[]): Announcement[] {
  const hashes = [...new Set(deliveries.map(({ sha256 }) => sha256))];
  return hashes
    .flatMap((sha256) => {
      const first = firstDelivery(deliveries, sha256);
      if (first === null) {
        return [];
      }
      const others = new Set(deliveries.filter((d) => d.sha256 === sha256 && d.worker !== first.worker).map(({ worker }) => worker));
      return [{ sha256, first, copies: others.size }];
    })
    .sort((a, b) => (earlier(a.first, b.first) ? -1 : earlier(b.first, a.first) ? 1 : 0));
}
