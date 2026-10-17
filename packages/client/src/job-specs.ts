import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { isSealed, NotInvited, parseSpecMemo, remainingOf, SPEC_MEMO_PREFIX, sealedTo, unseal } from "@intent-engine/core";
import { createdIn, hex, openProofEscrows, proofAt } from "./job-proofs.js";
import { MEMOS_PER_TRANSACTION, scan } from "./job-scan.js";
import { type EngineTransaction, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const SPEC_SCAN = 10;
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsfY";
export const PUBLIC_GENESIS_HASHES: ReadonlySet<string> = new Set([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH]);
export const MAX_SPEC_BYTES = 1_048_576;
export const SPEC_TIMEOUT_MS = 10_000;
export const PLAIN_HTTP_ON_PUBLIC = "is a plain http url, which a public cluster may not use";

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
  inputMint: Address;
  expiresAt: bigint;
};

export type Spec = { url: string; text: string; sha256: string; matches: boolean; sealedTo?: Address[] };

export type SpecFetch = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<Response>;

export class SpecSealed extends Error {
  readonly url: string;
  readonly to: Address[];
  readonly keyed: boolean;

  constructor(url: string, to: Address[], keyed: boolean) {
    super(
      `the spec at ${url} is sealed to ${to.length} invited wallet${to.length === 1 ? "" : "s"}; ${keyed ? "this wallet is not one of them" : "read it with the key of an invited wallet"}`,
    );
    this.name = "SpecSealed";
    this.url = url;
    this.to = to;
    this.keyed = keyed;
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

export async function readSpec(transport: Transport, get: SpecFetch, intent: Address, keypair?: Uint8Array): Promise<Spec | null> {
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    return null;
  }
  const url = await specUrlOf(transport, intent, proof.intent.createdAt);
  if (url === null) {
    return null;
  }
  if (await plainHttpOnPublic(transport, url)) {
    throw new SpecUnreadable(url, PLAIN_HTTP_ON_PUBLIC);
  }
  const fetched = await bounded(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) }), url);
  let bytes: Uint8Array = fetched;
  let to: Address[] | null = null;
  if (isSealed(fetched)) {
    to = sealedTo(fetched);
    if (keypair === undefined) {
      throw new SpecSealed(url, to, false);
    }
    try {
      bytes = await unseal(fetched, keypair);
    } catch (error) {
      throw error instanceof NotInvited ? new SpecSealed(url, to, true) : new SpecUnreadable(url, "is sealed but could not be opened");
    }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { url, text: new TextDecoder().decode(bytes), sha256, matches: sha256 === hex(proof.params.specHash), ...(to === null ? {} : { sealedTo: to }) };
}
