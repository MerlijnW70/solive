import type { Address } from "@solana/kit";
import { type DeliveryOpener, type EngineEvent, NotInvited, SealedError } from "@intent-engine/core";
import { decodeEvent, isSealed, parseSpecMemo, remainingOf, sealedTo, SPEC_MEMO_PREFIX, type UnreadableAccount, unseal } from "@intent-engine/core/internal";
import { loadConfig } from "./accounts.js";
import { type PayTerms, releaseNet } from "./job-pay.js";
import { memosSignedBy } from "./job-memos.js";
import { createdIn, hex, intentAt, type JobFilter, openProofEscrows, proofAt } from "./job-proofs.js";
import { MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { sha256Hex } from "./encoding.js";
import type { Lookup } from "./address-ranges.js";
import { type SpecFetch, SpecSealed, SpecUnreadable } from "./spec-guard.js";
import { guardedRead } from "./spec-fetch.js";
import { checkedSources, defaultSpecSources, fromHashSource, mismatched, NO_SPEC_URL, SPEC_READ_MS, SPEC_READ_OVER, type SpecAttempt, type SpecSource, type SpecSourceKind } from "./spec-sources.js";
import type { SpecCache } from "./spec-cache.js";
import { type EngineTransaction, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MAX_SPEC_BYTES,
  NOT_HTTP,
  NOT_PUBLIC_SPEC,
  PLAIN_HTTP_ON_PUBLIC,
  plainHttpOnPublic,
  PUBLIC_GENESIS_HASHES,
  SPEC_FETCH_FAILED,
  SPEC_REDIRECTS,
  SPEC_TIMEOUT_MS,
  type SpecFetch,
  type SpecRequest,
  SpecSealed,
  SpecUnreadable,
  TESTNET_GENESIS_HASH,
} from "./spec-guard.js";

export const SPEC_SCAN = 10;

export type Job = {
  intent: Address;
  owner: Address;
  nonce: bigint;
  attestor: Address;
  specHash: string;
  specUrl: string | null;
  sells: bigint;
  judgeFee: bigint;
  net: bigint | null;
  feeBps: number;
  inputMint: Address;
  expiresAt: bigint;
};

export type Spec = {
  url: string;
  text: string;
  bytes: Uint8Array;
  sha256: string;
  matches: boolean;
  sealedTo?: Address[];
  source: SpecSourceKind | "cache";
  tried: SpecAttempt[];
};

export type SpecReadOptions = { sources?: readonly SpecSource[]; cache?: SpecCache; budgetMs?: number };

export const webFetch: SpecFetch = (url, init) =>
  fetch(url, {
    redirect: init.redirect,
    signal: init.signal,
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body as NonNullable<RequestInit["body"]> }),
  });

function createdOwner(transaction: EngineTransaction, intent: Address): Address | null {
  for (const data of transaction.emitted) {
    const event = decodeEvent(data) as EngineEvent | null;
    if (event?.name === "IntentCreated" && event.fields.intent === intent) {
      return event.fields.owner;
    }
  }
  return null;
}

export async function specUrlOf(transport: Transport, intent: Address, createdAt?: bigint, owner?: Address): Promise<string | null> {
  const known = createdAt !== undefined && owner !== undefined ? null : await intentAt(transport, intent);
  const floor = createdAt ?? known?.createdAt ?? null;
  const created = (transaction: EngineTransaction) => !transaction.failed && createdIn(transaction.emitted, intent);
  const { transactions } = await scan(transport, intent, { floor, memo: SPEC_MEMO_PREFIX, until: created });
  const tx = transactions.find(created);
  const signer = owner ?? known?.owner ?? (tx === undefined ? null : createdOwner(tx, intent));
  if (tx === undefined || signer === null) {
    return null;
  }
  const signed = { ...tx, memos: (tx.memos ?? []).slice(0, MEMOS_PER_TRANSACTION) };
  const urls = new Set(
    memosSignedBy(signed, signer)
      .map(parseSpecMemo)
      .flatMap((memo) => (memo === null ? [] : [memo.url])),
  );
  return urls.size === 1 ? ([...urls][0] ?? null) : null;
}

export type JobList = { jobs: Job[]; unreadable: UnreadableAccount[] };

export async function jobsOf(transport: Transport, filter?: Address | JobFilter, terms?: PayTerms): Promise<JobList> {
  const [{ proofs, unreadable }, config] = await Promise.all([openProofEscrows(transport, filter), terms ?? loadConfig(transport).then(({ config }) => config)]);
  const urls: (string | null)[] = [];
  for (let at = 0; at < proofs.length; at += TRANSACTION_FETCHES) {
    urls.push(...(await Promise.all(proofs.slice(at, at + TRANSACTION_FETCHES).map(({ address, intent }) => specUrlOf(transport, address, intent.createdAt, intent.owner)))));
  }
  const jobs = proofs.map(({ address, intent, params }, i) => ({
    intent: address,
    owner: intent.owner,
    nonce: intent.nonce,
    attestor: params.attestor,
    specHash: hex(params.specHash),
    specUrl: urls[i] ?? null,
    sells: remainingOf(intent),
    judgeFee: params.judgeFee,
    net: releaseNet(intent, config),
    feeBps: intent.feeBps,
    inputMint: intent.inputMint,
    expiresAt: intent.expiresAt,
  }));
  return { jobs, unreadable };
}

async function specOf(url: string, bytes: Uint8Array, hash: string, source: Spec["source"], tried: SpecAttempt[], to?: Address[]): Promise<Spec> {
  const sha256 = await sha256Hex(bytes);
  return { url, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), bytes, sha256, matches: sha256 === hash, ...(to === undefined ? {} : { sealedTo: to }), source, tried };
}

async function opened(url: string, fetched: Uint8Array, keypair: DeliveryOpener | readonly DeliveryOpener[] | undefined, hash: string, tried: SpecAttempt[]): Promise<Spec> {
  let to: Address[];
  try {
    to = sealedTo(fetched);
  } catch (error) {
    throw error instanceof SealedError ? new SpecUnreadable(url, `is sealed but could not be opened: ${error.message}`, { cause: error }) : error;
  }
  if (keypair === undefined || (Array.isArray(keypair) && keypair.length === 0)) {
    throw new SpecSealed(url, to, false);
  }
  let bytes: Uint8Array;
  try {
    bytes = await unseal(fetched, keypair);
  } catch (error) {
    throw error instanceof NotInvited ? new SpecSealed(url, to, true) : new SpecUnreadable(url, `is sealed but could not be opened${error instanceof SealedError ? `: ${error.message}` : ""}`);
  }
  return specOf(url, bytes, hash, "memo", tried, to);
}

export async function readSpec(
  transport: Transport,
  get: SpecFetch,
  intent: Address,
  keypair: DeliveryOpener | readonly DeliveryOpener[] | undefined,
  lookup: Lookup | null,
  rpcUrl?: string,
  options: SpecReadOptions = {},
): Promise<Spec | null> {
  const sources = checkedSources(options.sources ?? defaultSpecSources());
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    return null;
  }
  const hash = hex(proof.params.specHash);
  const { cache } = options;
  const key = `${intent} ${hash}`;
  const cached = cache?.get(key);
  if (cached !== undefined) {
    return specOf(cached.url, cached.bytes, hash, "cache", []);
  }
  const url = await specUrlOf(transport, intent, proof.intent.createdAt, proof.intent.owner);
  const deadline = AbortSignal.timeout(options.budgetMs ?? SPEC_READ_MS);
  const reach = { transport, get, lookup, rpcUrl, deadline };
  const tried: SpecAttempt[] = [];
  let failed: SpecUnreadable | undefined;
  let mismatch: Spec | undefined;
  let memoRead = false;
  for (const source of sources) {
    if (deadline.aborted) {
      tried.push({ source: source.kind, url: null, reason: SPEC_READ_OVER });
      continue;
    }
    if (source.kind !== "memo") {
      const served = await fromHashSource(reach, source, hash, tried);
      if (served !== null) {
        if (url === null) {
          cache?.put(key, served.url, served.bytes);
        }
        return specOf(served.url, served.bytes, hash, source.kind, tried);
      }
      continue;
    }
    if (memoRead) {
      continue;
    }
    memoRead = true;
    if (url === null) {
      tried.push({ source: "memo", url: null, reason: NO_SPEC_URL });
      continue;
    }
    let fetched: Uint8Array;
    try {
      fetched = await guardedRead(transport, get, url, lookup, rpcUrl, {}, deadline);
    } catch (error) {
      if (!(error instanceof SpecUnreadable)) {
        throw error;
      }
      failed = error;
      tried.push({ source: "memo", url, reason: error.message });
      continue;
    }
    if (isSealed(fetched)) {
      return opened(url, fetched, keypair, hash, tried);
    }
    const spec = await specOf(url, fetched, hash, "memo", tried);
    if (spec.matches) {
      cache?.put(key, url, fetched);
      return spec;
    }
    mismatch = spec;
    tried.push({ source: "memo", url, reason: `the spec at ${url} ${mismatched(spec.sha256)}` });
  }
  if (mismatch !== undefined) {
    return mismatch;
  }
  if (failed !== undefined) {
    throw failed;
  }
  return null;
}
