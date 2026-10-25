import type { Address } from "@solana/kit";
import { type DeliveryOpener, type EngineEvent, isSdkError, NotInvited, SdkError, SealedError } from "@intent-engine/core";
import { decodeEvent, isSealed, parseSpecMemo, remainingOf, sealedTo, SPEC_MEMO_PREFIX, unseal } from "@intent-engine/core/internal";
import { memosSignedBy } from "./job-memos.js";
import { createdIn, hex, intentAt, type JobFilter, openProofEscrows, proofAt } from "./job-proofs.js";
import { MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { UNEXPECTED_REDIRECT } from "./fetch-failed.js";
import { joinedBytes, sha256Hex } from "./encoding.js";
import { hostAddresses, type Lookup, loopbackUrl } from "./address-ranges.js";
import { type EngineTransaction, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const SPEC_SCAN = 10;
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsfY";
export const PUBLIC_GENESIS_HASHES: ReadonlySet<string> = new Set([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH]);
export const MAX_SPEC_BYTES = 1_048_576;
export const SPEC_TIMEOUT_MS = 10_000;
export const PLAIN_HTTP_ON_PUBLIC = "is a plain http url, which a public cluster may not use";
export const NOT_HTTP = "is not an http or https url";
export const NOT_PUBLIC_SPEC = "points to a private, loopback or local network address, which is not fetched";
export const SPEC_FETCH_FAILED = "could not be fetched";
export const SPEC_REDIRECTS = "redirects, and a spec url is read without following redirects";

export async function plainHttpOnPublic(transport: Transport, url: string): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return protocol === "http:" && PUBLIC_GENESIS_HASHES.has(await transport.genesisHash());
}

export type Job = {
  intent: Address;
  owner: Address;
  nonce: bigint;
  attestor: Address;
  specHash: string;
  specUrl: string | null;
  sells: bigint;
  judgeFee: bigint;
  feeBps: number;
  inputMint: Address;
  expiresAt: bigint;
};

export type Spec = { url: string; text: string; bytes: Uint8Array; sha256: string; matches: boolean; sealedTo?: Address[] };

export type SpecFetch = (url: string, init: { redirect: "error"; signal: AbortSignal; addresses?: readonly string[] }) => Promise<Response>;

export const webFetch: SpecFetch = (url, init) => fetch(url, { redirect: init.redirect, signal: init.signal });

export class SpecSealed extends SdkError {
  readonly code = "spec-sealed";
  override readonly name = "SpecSealed";
  readonly url: string;
  readonly to: Address[];
  readonly keyed: boolean;

  constructor(url: string, to: Address[], keyed: boolean) {
    super(
      `the spec at ${url} is sealed to ${to.length} invited wallet${to.length === 1 ? "" : "s"}; ${keyed ? "this wallet is not one of them" : "read it with the key of an invited wallet"}`,
    );
    this.url = url;
    this.to = to;
    this.keyed = keyed;
  }
}

export class SpecUnreadable extends SdkError {
  readonly code = "spec-unreadable";
  override readonly name = "SpecUnreadable";
  readonly url: string;

  constructor(url: string, reason: string, options?: ErrorOptions) {
    super(`the spec at ${url} ${reason}`, options);
    this.url = url;
  }
}

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

export async function jobsOf(transport: Transport, filter?: Address | JobFilter): Promise<Job[]> {
  const proofs = await openProofEscrows(transport, filter);
  const urls: (string | null)[] = [];
  for (let at = 0; at < proofs.length; at += TRANSACTION_FETCHES) {
    urls.push(...(await Promise.all(proofs.slice(at, at + TRANSACTION_FETCHES).map(({ address, intent }) => specUrlOf(transport, address, intent.createdAt, intent.owner)))));
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
    feeBps: intent.feeBps,
    inputMint: intent.inputMint,
    expiresAt: intent.expiresAt,
  }));
}

async function discarded(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function before<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function bounded(response: Response, url: string, signal: AbortSignal): Promise<Uint8Array> {
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
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await before(signal, reader.read()); next.done !== true; next = await before(signal, reader.read())) {
      size += next.value.length;
      if (size > MAX_SPEC_BYTES) {
        throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return joinedBytes(chunks);
}

function fetchProblem(error: unknown): string {
  if (isSdkError(error, "fetch-failed")) {
    return error.reason === "redirect" ? SPEC_REDIRECTS : `${SPEC_FETCH_FAILED} (${error.message}: ${error.detail})`;
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  if (cause === UNEXPECTED_REDIRECT) {
    return SPEC_REDIRECTS;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${SPEC_FETCH_FAILED} (${cause === "" ? message : `${message}: ${cause}`})`;
}

export async function readSpec(
  transport: Transport,
  get: SpecFetch,
  intent: Address,
  keypair: DeliveryOpener | readonly DeliveryOpener[] | undefined,
  lookup: Lookup | null,
  rpcUrl?: string,
): Promise<Spec | null> {
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    return null;
  }
  const url = await specUrlOf(transport, intent, proof.intent.createdAt, proof.intent.owner);
  if (url === null) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SpecUnreadable(url, "is not a url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SpecUnreadable(url, NOT_HTTP);
  }
  if (await plainHttpOnPublic(transport, url)) {
    throw new SpecUnreadable(url, PLAIN_HTTP_ON_PUBLIC);
  }
  const signal = AbortSignal.timeout(SPEC_TIMEOUT_MS);
  let fetched: Uint8Array;
  try {
    const addresses = await before(signal, hostAddresses(parsed.hostname, lookup, rpcUrl !== undefined && loopbackUrl(rpcUrl)));
    if (addresses === null) {
      throw new SpecUnreadable(url, NOT_PUBLIC_SPEC);
    }
    fetched = await bounded(await before(signal, get(url, { redirect: "error", signal, ...(addresses === undefined ? {} : { addresses }) })), url, signal);
  } catch (error) {
    throw error instanceof SpecUnreadable ? error : new SpecUnreadable(url, fetchProblem(error), { cause: error });
  }
  let bytes: Uint8Array = fetched;
  let to: Address[] | null = null;
  if (isSealed(fetched)) {
    try {
      to = sealedTo(fetched);
    } catch (error) {
      throw error instanceof SealedError ? new SpecUnreadable(url, `is sealed but could not be opened: ${error.message}`, { cause: error }) : error;
    }
    if (keypair === undefined || (Array.isArray(keypair) && keypair.length === 0)) {
      throw new SpecSealed(url, to, false);
    }
    try {
      bytes = await unseal(fetched, keypair);
    } catch (error) {
      throw error instanceof NotInvited ? new SpecSealed(url, to, true) : new SpecUnreadable(url, `is sealed but could not be opened${error instanceof SealedError ? `: ${error.message}` : ""}`);
    }
  }
  const sha256 = await sha256Hex(bytes);
  return { url, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), bytes, sha256, matches: sha256 === hex(proof.params.specHash), ...(to === null ? {} : { sealedTo: to }) };
}
