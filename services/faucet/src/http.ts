import type { IncomingMessage, ServerResponse } from "node:http";
import { createSolanaRpc } from "@solana/kit";
import { CallerLimit } from "./callers.js";
import type { Clock } from "./chain.js";
import { drip, type DripDeps, type DripResponse } from "./drip.js";
import { DEFAULT_RPC_URL, MAX_BODY_BYTES } from "./limits.js";
import { NOT_JSON } from "./request.js";

export type BodyRead = { readonly ok: true; readonly body: string } | { readonly ok: false };

export async function readBody(request: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const piece = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      size += piece.length;
      if (size > limit) return { ok: false };
      chunks.push(piece);
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

export function write(response: ServerResponse, answer: DripResponse): void {
  response.statusCode = answer.status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  for (const [name, value] of Object.entries(answer.headers ?? {})) response.setHeader(name, value);
  response.end(JSON.stringify(answer.body));
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal: (ms) => AbortSignal.timeout(ms),
};

export function envDeps(callers: CallerLimit = new CallerLimit()): DripDeps {
  return {
    rpc: () => createSolanaRpc(process.env["FAUCET_RPC_URL"] || DEFAULT_RPC_URL),
    secret: () => process.env["FAUCET_SECRET"],
    callers,
    clock: systemClock,
    log: (line) => console.log(line),
  };
}

export function createHandler(deps: DripDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const method = request.method;
    let body: string | undefined;
    if (method === "POST") {
      const read = await readBody(request);
      if (!read.ok) {
        deps.log(JSON.stringify({ status: 400 }));
        write(response, { status: 400, body: { error: NOT_JSON } });
        return;
      }
      body = read.body;
    }
    write(response, await drip({ method, headers: request.headers, body, remote: request.socket?.remoteAddress }, deps));
  };
}
