import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSolanaRpc } from "@solana/kit";
import { CallerLimit } from "./callers.js";
import { DEFAULT_RPC_URL, REQUEST_DEADLINE_MS, SWEEP_STORE_TIMEOUT_MS } from "./limits.js";
import { mirror, type MirrorDeps } from "./mirror.js";
import { blobStore, blobStoreWith } from "./store.js";
import { sweep, type SweepDeps } from "./sweep.js";

type Headers = IncomingMessage["headers"];

export class BodyBuffer {
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(readonly limit: number) {}

  add(piece: Buffer): void {
    this.#size += piece.length;
    if (this.#size > this.limit) this.#chunks = [];
    else this.#chunks.push(piece);
  }

  bytes(): Uint8Array | null {
    return this.#size > this.limit ? null : Buffer.concat(this.#chunks);
  }
}

export async function readBody(request: AsyncIterable<unknown>, limit: number): Promise<Uint8Array | null> {
  const buffer = new BodyBuffer(limit);
  for await (const chunk of request) buffer.add(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return buffer.bytes();
}

function first(value: string | readonly string[] | undefined): string | undefined {
  const raw = typeof value === "string" ? value : value?.[0];
  const entry = raw?.split(",")[0]?.trim();
  return entry === undefined || entry === "" ? undefined : entry;
}

export function callerOf(headers: Headers, fallback?: string): string {
  return first(headers["x-forwarded-for"]) ?? first(headers["x-real-ip"]) ?? fallback ?? "unknown";
}

const rpcOf = () => createSolanaRpc(process.env["SPECS_RPC_URL"] || DEFAULT_RPC_URL);

export function envDeps(callers: CallerLimit = new CallerLimit()): MirrorDeps {
  return {
    rpc: rpcOf,
    store: blobStore,
    callers,
    now: () => Date.now(),
    deadlineMs: REQUEST_DEADLINE_MS,
    log: (line) => console.log(line),
  };
}

export function envSweepDeps(): SweepDeps {
  return { rpc: rpcOf, store: blobStoreWith(SWEEP_STORE_TIMEOUT_MS), now: () => Date.now() };
}

export function createHandler(deps: MirrorDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const answer = await mirror(
      {
        method: request.method,
        url: request.url ?? "/",
        caller: callerOf(request.headers, request.socket?.remoteAddress),
        body: (limit) => readBody(request, limit),
      },
      deps,
    );
    response.statusCode = answer.status;
    for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);
    response.end(answer.body);
  };
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

export function authorized(header: string | undefined, secret: string | undefined): boolean {
  if (secret === undefined || secret === "" || header === undefined) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export function createSweepHandler(deps: SweepDeps, secret: () => string | undefined = () => process.env["CRON_SECRET"]): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const answer = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify(body));
    };
    if (request.method !== "GET") return answer(405, { error: "The sweep takes GET only." });
    if (!authorized(request.headers.authorization, secret())) return answer(401, { error: "The sweep needs the cron secret." });
    try {
      answer(200, await sweep(deps));
    } catch {
      answer(503, { error: "The sweep stopped because the node or the store did not answer." });
    }
  };
}
