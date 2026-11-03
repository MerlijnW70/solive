import { createHash } from "node:crypto";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { specHashOfCid } from "@intent-engine/client";
import type { CallerLimit } from "./callers.js";
import { onDevnet, openEscrowHolds, type MirrorRpc } from "./chain.js";
import { IMMUTABLE_SECS, MAX_STORED_BYTES } from "./limits.js";
import type { SpecStore } from "./store.js";
import { within } from "./within.js";

export type MirrorRequest = {
  readonly method: string | undefined;
  readonly url: string;
  readonly caller: string;
  readonly body: (limit: number) => Promise<Uint8Array | null>;
};

export type MirrorResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
};

export type MirrorDeps = {
  readonly rpc: () => MirrorRpc;
  readonly store: SpecStore;
  readonly callers: CallerLimit;
  readonly now: () => number;
  readonly deadlineMs: number;
  readonly log: (line: string) => void;
};

export const REASONS = {
  badHash: "A spec hash is 64 lowercase hex characters.",
  badCid: "This is not the CIDv1 raw sha256 of a spec, or the request lacks format=raw.",
  unknown: "No spec with this hash is stored here.",
  route: "This service serves /sha256/{hex} and /ipfs/{cid}?format=raw.",
  method: "This address does not take that method.",
  caller: "This network sent the most uploads allowed for now, so wait retry_after seconds before you send another.",
  oversize: `A spec may be at most ${MAX_SPEC_BYTES} bytes, so nothing was stored.`,
  mismatch: "The sha256 of these bytes is not the hash in the address, so nothing was stored.",
  noEscrow: "The program holds no open proof escrow with this spec hash, so nothing was stored.",
  cluster: "The node of this service is not on devnet, so nothing was stored and its owner needs to fix the node url.",
  corrupt: "The stored bytes do not match this hash, so they were not served.",
  full: "The mirror holds as much as it may store in total, so nothing was stored.",
  down: "The node or the store did not answer, so try again in a minute.",
} as const;

const HEX = /^[0-9a-f]{64}$/;
const SHA256_PATH = /^\/sha256\/([^/]*)$/;
const IPFS_PATH = /^\/ipfs\/([^/]*)$/;
const REWRITTEN_PATH = "/api/specs";

type Route = { readonly kind: "sha256" | "ipfs"; readonly key: string; readonly raw: boolean };

function routeOf(url: string): Route | null {
  let parsed: URL;
  try {
    parsed = new URL(`http://mirror.invalid${url}`);
  } catch {
    return null;
  }
  const { pathname, searchParams } = parsed;
  const raw = searchParams.get("format") === "raw";
  const sha256 = pathname === REWRITTEN_PATH ? searchParams.get("sha256") : SHA256_PATH.exec(pathname)?.[1];
  if (typeof sha256 === "string") return { kind: "sha256", key: sha256, raw };
  const ipfs = pathname === REWRITTEN_PATH ? searchParams.get("ipfs") : IPFS_PATH.exec(pathname)?.[1];
  if (typeof ipfs === "string") return { kind: "ipfs", key: ipfs, raw };
  return null;
}

const encoder = new TextEncoder();
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const isRead = (method: string | undefined): boolean => method === "GET" || method === "HEAD";

function refused(status: number, reason: string, headers: Record<string, string> = {}, extra: Record<string, number> = {}): MirrorResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
    body: encoder.encode(JSON.stringify({ error: reason, ...extra })),
  };
}

function kept(status: number, hex: string): MirrorResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    body: encoder.encode(JSON.stringify({ sha256: hex })),
  };
}

async function served(hex: string, deps: MirrorDeps): Promise<MirrorResponse> {
  const bytes = await deps.store.read(hex);
  if (bytes === null) return refused(404, REASONS.unknown);
  if (sha256Of(bytes) !== hex) return refused(503, REASONS.corrupt);
  return {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "cache-control": `public, max-age=${IMMUTABLE_SECS}, immutable`,
    },
    body: bytes,
  };
}

async function stored(hex: string, request: MirrorRequest, deps: MirrorDeps): Promise<MirrorResponse> {
  const bytes = await request.body(MAX_SPEC_BYTES);
  if (bytes === null) return refused(413, REASONS.oversize);
  if (sha256Of(bytes) !== hex) return refused(400, REASONS.mismatch);
  const rpc = deps.rpc();
  if (!(await onDevnet(rpc))) return refused(503, REASONS.cluster);
  if (!(await openEscrowHolds(rpc, hex))) return refused(403, REASONS.noEscrow);
  if (await deps.store.has(hex)) return kept(200, hex);
  const held = await deps.store.total();
  if (held >= MAX_STORED_BYTES || held + bytes.length > MAX_STORED_BYTES) return refused(507, REASONS.full);
  return kept((await deps.store.write(hex, bytes)) ? 201 : 200, hex);
}

async function answered(request: MirrorRequest, deps: MirrorDeps): Promise<MirrorResponse> {
  const route = routeOf(request.url);
  if (route === null) return refused(404, REASONS.route);
  if (route.kind === "ipfs") {
    if (!isRead(request.method)) return refused(405, REASONS.method, { allow: "GET, HEAD" });
    const hex = route.raw ? specHashOfCid(route.key) : null;
    return hex === null ? refused(400, REASONS.badCid) : served(hex, deps);
  }
  if (!isRead(request.method) && request.method !== "PUT") return refused(405, REASONS.method, { allow: "GET, HEAD, PUT" });
  if (!HEX.test(route.key)) return refused(400, REASONS.badHash);
  if (isRead(request.method)) return served(route.key, deps);
  const now = deps.now();
  deps.callers.forget(now);
  const retryAfter = deps.callers.retryAfter(request.caller, now);
  if (retryAfter !== null) return refused(429, REASONS.caller, { "retry-after": String(retryAfter) }, { retry_after: retryAfter });
  return stored(route.key, request, deps);
}

export async function mirror(request: MirrorRequest, deps: MirrorDeps): Promise<MirrorResponse> {
  let response: MirrorResponse;
  try {
    response = await within(answered(request, deps), deps.deadlineMs);
  } catch {
    response = refused(503, REASONS.down);
  }
  deps.log(JSON.stringify({ method: request.method, status: response.status }));
  if (!isRead(request.method)) return response;
  return {
    status: response.status,
    headers: { ...response.headers, "access-control-allow-origin": "*" },
    body: request.method === "HEAD" ? new Uint8Array() : response.body,
  };
}
