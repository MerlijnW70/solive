import { InvalidInput } from "@intent-engine/core";
import { isSealed } from "@intent-engine/core/internal";
import type { Lookup } from "./address-ranges.js";
import { sha256Hex } from "./encoding.js";
import { type SpecFetch, SpecUnreadable } from "./spec-guard.js";
import { cidOfSpecHash } from "./spec-cid.js";
import { guardedRead } from "./spec-fetch.js";
import type { Transport } from "./transport.js";

export type SpecSource = { kind: "memo" } | { kind: "mirror"; base: string } | { kind: "ipfs"; gateway: string } | { kind: "arweave"; gateway: string };

export type SpecSourceKind = SpecSource["kind"];

export type SpecAttempt = { source: SpecSourceKind; url: string | null; reason: string };

export const DEFAULT_SPEC_SOURCES: readonly SpecSource[] = Object.freeze([
  { kind: "memo" },
  { kind: "ipfs", gateway: "https://gateway.pinata.cloud" },
  { kind: "ipfs", gateway: "https://ipfs.filebase.io" },
  { kind: "arweave", gateway: "https://arweave.net" },
]);

export const ARWEAVE_IDS = 3;
export const SPEC_READ_MS = 20_000;
export const MEMO_FIRST = "specSources must start with { kind: \"memo\" }, so a spec is read from its own url, and seen sealed, before any copy";
export const SPEC_READ_OVER = `the read of this spec ran past ${SPEC_READ_MS} ms, so this source was not asked`;
export const SPEC_HASH_TAG = "Spec-Sha256";
export const IPLD_RAW = "application/vnd.ipld.raw";
export const NO_SPEC_URL = "the escrow publishes no spec url";
export const SEALED_FROM_HASH_SOURCE = "is sealed, and a sealed spec is never read from a hash source";
export const NO_ARWEAVE_ID = "lists no upload tagged with this spec hash";
export const NOT_GRAPHQL = "answered no readable list of uploads";

const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const ARWEAVE_QUERY = `query($hash: String!) { transactions(first: ${ARWEAVE_IDS}, tags: [{ name: "${SPEC_HASH_TAG}", values: [$hash] }]) { edges { node { id } } } }`;

const trimmed = (base: string): string => base.replace(/\/+$/, "");

export const mismatched = (sha256: string): string => `answered bytes whose sha256 is ${sha256}, not the escrow's spec_hash`;

type Reach = { transport: Transport; get: SpecFetch; lookup: Lookup | null; rpcUrl?: string | undefined; deadline?: AbortSignal };

export function checkedSources(sources: readonly SpecSource[]): readonly SpecSource[] {
  if (sources[0]?.kind !== "memo") {
    throw new InvalidInput("specSources", "order", MEMO_FIRST);
  }
  return sources;
}

export type Served = { url: string; bytes: Uint8Array };

function idsOf(bytes: Uint8Array, url: string): string[] {
  let edges: unknown;
  try {
    edges = (JSON.parse(new TextDecoder().decode(bytes)) as { data?: { transactions?: { edges?: unknown } } }).data?.transactions?.edges;
  } catch {
    throw new SpecUnreadable(url, NOT_GRAPHQL);
  }
  if (!Array.isArray(edges)) {
    throw new SpecUnreadable(url, NOT_GRAPHQL);
  }
  const ids = edges.map((edge: { node?: { id?: unknown } } | null) => edge?.node?.id).filter((id): id is string => typeof id === "string" && ARWEAVE_ID.test(id));
  if (ids.length === 0) {
    throw new SpecUnreadable(url, NO_ARWEAVE_ID);
  }
  return ids.slice(0, ARWEAVE_IDS);
}

async function verified(reach: Reach, url: string, hash: string, tried: SpecAttempt[], source: SpecSourceKind, request?: Parameters<typeof guardedRead>[5]): Promise<Served | null> {
  let bytes: Uint8Array;
  try {
    bytes = await guardedRead(reach.transport, reach.get, url, reach.lookup, reach.rpcUrl, request, reach.deadline);
  } catch (error) {
    if (error instanceof SpecUnreadable) {
      tried.push({ source, url, reason: error.message });
      return null;
    }
    throw error;
  }
  if (isSealed(bytes)) {
    tried.push({ source, url, reason: `the spec at ${url} ${SEALED_FROM_HASH_SOURCE}` });
    return null;
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== hash) {
    tried.push({ source, url, reason: `the spec at ${url} ${mismatched(sha256)}` });
    return null;
  }
  return { url, bytes };
}

async function fromArweave(reach: Reach, gateway: string, hash: string, tried: SpecAttempt[]): Promise<Served | null> {
  const query = `${trimmed(gateway)}/graphql`;
  let ids: string[];
  try {
    const body = JSON.stringify({ query: ARWEAVE_QUERY, variables: { hash } });
    ids = idsOf(await guardedRead(reach.transport, reach.get, query, reach.lookup, reach.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body }, reach.deadline), query);
  } catch (error) {
    if (error instanceof SpecUnreadable) {
      tried.push({ source: "arweave", url: query, reason: error.message });
      return null;
    }
    throw error;
  }
  for (const id of ids) {
    const served = await verified(reach, `${trimmed(gateway)}/raw/${id}`, hash, tried, "arweave");
    if (served !== null) {
      return served;
    }
  }
  return null;
}

export function fromHashSource(reach: Reach, source: Exclude<SpecSource, { kind: "memo" }>, hash: string, tried: SpecAttempt[]): Promise<Served | null> {
  switch (source.kind) {
    case "mirror":
      return verified(reach, `${trimmed(source.base)}/sha256/${hash}`, hash, tried, "mirror");
    case "ipfs":
      return verified(reach, `${trimmed(source.gateway)}/ipfs/${cidOfSpecHash(hash)}?format=raw`, hash, tried, "ipfs", { headers: { accept: IPLD_RAW } });
    case "arweave":
      return fromArweave(reach, source.gateway, hash, tried);
  }
}
