import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultRpcTransport, type RpcTransport } from "@solana/kit";
import { configFrom, type Env, type FeedConfig } from "./env.js";
import { LiveFeed } from "./feed.js";
import { CACHE_CONTROL, CDN_CACHE_CONTROL, FAUCET_URL, LIMITS, type Limits } from "./limits.js";
import { readerOf } from "./reader.js";
import { guardedTransport } from "./rpc.js";
import type { Probe } from "./services.js";
import type { Feed } from "./shapes.js";
import { type RuntimeCache, StateStore } from "./store.js";

export const FEED_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": CACHE_CONTROL,
  "vercel-cdn-cache-control": CDN_CACHE_CONTROL,
  "x-content-type-options": "nosniff",
};

export type Answer = { status: number; headers: Readonly<Record<string, string>>; body: Feed | { error: string } };

export async function answer(method: string | undefined, feed: LiveFeed): Promise<Answer> {
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD", "cache-control": "no-store" }, body: { error: "only GET reads the feed" } };
  }
  return { status: 200, headers: FEED_HEADERS, body: await feed.read() };
}

export function write(response: ServerResponse, reply: Answer, head: boolean): void {
  response.statusCode = reply.status;
  for (const [name, value] of Object.entries(reply.headers)) {
    response.setHeader(name, value);
  }
  response.end(head ? undefined : JSON.stringify(reply.body));
}

export function createHandler(feed: LiveFeed): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    write(response, await answer(request.method, feed), request.method === "HEAD");
  };
}

export const faucetProbe: Probe = async (signal) => {
  const reply = await fetch(FAUCET_URL, { method: "GET", redirect: "manual", signal });
  await reply.body?.cancel();
  return reply.status;
};

export type Wiring = {
  env: Env;
  cache: () => RuntimeCache | null;
  transport?: RpcTransport;
  probe?: Probe;
  limits?: Limits;
  now?: () => number;
  log?: (line: string) => void;
};

export function liveFeed({ env, cache, transport, probe = faucetProbe, limits = LIMITS, now = Date.now, log = (line) => console.log(line) }: Wiring): LiveFeed {
  const config: FeedConfig = configFrom(env);
  const base = transport ?? createDefaultRpcTransport({ url: config.rpcUrl });
  return new LiveFeed({
    config,
    store: new StateStore(cache, log),
    connect: (deadline) => readerOf(guardedTransport(base, limits.callTimeoutMs, deadline, now)),
    probe,
    limits,
    now,
    log,
  });
}
