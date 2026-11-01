import { getBase58Decoder, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS, NATIVE_MINT } from "@intent-engine/core";
import { PAID_WINDOW_SECS, STATE_KEY } from "../src/limits.js";
import type { Feed, State } from "../src/shapes.js";
import { addressOf, attested, claimed, JUDGE, OWNER, released, type Tx, WORKER } from "./chain.js";
import type { Call } from "./fake-node.js";
import { type MemoryCache, nowSecs } from "./harness.js";

export const SPACING_SECS = 2400;
export const sig = (n: number): string => {
  const bytes = new Uint8Array(64).fill(9);
  bytes[0] = n >> 8;
  bytes[1] = n & 255;
  return getBase58Decoder().decode(bytes);
};

export const at = (n: number, total: number, events: Uint8Array[], mints: Tx["mints"] = []): Tx => ({
  signature: sig(n),
  slot: 10_000 + n,
  blockTime: nowSecs(-(total - n) * SPACING_SECS - SPACING_SECS / 2),
  events,
  mints,
});

export const isPay = (n: number): boolean => n % 3 === 0;

export function chainOf(total: number): Tx[] {
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const intent = addressOf(100 + (n % 50));
    return isPay(n) ? at(n, total, [released(intent, WORKER, JUDGE), attested(intent, OWNER, WORKER, JUDGE, 1_000_000n)], [NATIVE_MINT]) : at(n, total, [claimed(intent, WORKER, 0n)]);
  });
}

export const inWindow = (tx: Tx, now: number): boolean => tx.blockTime * 1000 >= now - PAID_WINDOW_SECS * 1000;
export const paidIn = (txs: readonly Tx[], now: number): number => txs.filter((tx) => isPay(Number(tx.slot) - 10_000) && inWindow(tx, now)).length;
export const stored = (cache: MemoryCache): State => JSON.parse(String(cache.values.get(STATE_KEY))) as State;
export const listings = (calls: readonly Call[]) => calls.filter(({ method, params }) => method === "getSignaturesForAddress" && params[0] === INTENT_ENGINE_PROGRAM_ADDRESS);
export const configOf = (call: Call | undefined) => (call?.params[1] ?? {}) as { before?: string; until?: string; limit?: number };
export const olderListings = (calls: readonly Call[]) => listings(calls).filter((call) => configOf(call).before !== undefined || (configOf(call).until === undefined && calls.indexOf(call) > 0));
export const readSignatures = (calls: readonly Call[]): string[] => calls.filter(({ method }) => method === "getTransaction").map(({ params }) => params[0] as string);

export const tooMany = (retryAfter: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "retry-after": retryAfter }), message: "Too Many Requests", statusCode: 429 });

export async function untilComplete(feed: { read(): Promise<Feed> }, tick: (secs: number) => number, most: number): Promise<Feed[]> {
  const seen: Feed[] = [];
  for (let refresh = 0; refresh < most; refresh++) {
    const body = await feed.read();
    seen.push(body);
    if (body.history.complete) {
      return seen;
    }
    tick(31);
  }
  return seen;
}
