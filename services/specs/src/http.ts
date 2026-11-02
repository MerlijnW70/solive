import type { IncomingMessage, ServerResponse } from "node:http";
import { createSolanaRpc } from "@solana/kit";
import { CallerLimit } from "./callers.js";
import { DEFAULT_RPC_URL, REQUEST_DEADLINE_MS } from "./limits.js";
import { mirror, type MirrorDeps } from "./mirror.js";
import { blobStore } from "./store.js";

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

  get held(): number {
    return this.#chunks.reduce((total, chunk) => total + chunk.length, 0);
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

export function envDeps(callers: CallerLimit = new CallerLimit()): MirrorDeps {
  return {
    rpc: () => createSolanaRpc(process.env["SPECS_RPC_URL"] || DEFAULT_RPC_URL),
    store: blobStore,
    callers,
    now: () => Date.now(),
    deadlineMs: REQUEST_DEADLINE_MS,
    log: (line) => console.log(line),
  };
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
