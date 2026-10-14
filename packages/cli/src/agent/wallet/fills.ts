import type { Address } from "@solana/kit";
import { decodeEvent, getIntentDecoder } from "@intent-engine/core";
import type { EngineTransaction, Transport } from "@intent-engine/client";
import { ESTIMATE_SCAN, ESTIMATE_FILLS } from "./guard.js";

export const SWAP_HEADROOM_BPS = 200n;
export const SWAP_BLIND_BPS = 2_500n;
export const SWAP_CAP_BPS = 20_000n;

export async function recentFills(transport: Transport, inputMint: Address, outputMint: Address): Promise<Fill[]> {
  const { created, fills } = await engineHistory(transport, ESTIMATE_SCAN);
  const unknown = [...new Set(fills.map((f) => f.intent).filter((intent) => !created.has(intent)))];
  const views = unknown.length === 0 ? [] : await transport.getAccounts(unknown);
  unknown.forEach((intent, i) => {
    const view = views[i];
    const pair = view === null || view === undefined ? null : pairOf(view.data);
    if (pair !== null) {
      created.set(intent, pair);
    }
  });
  return fills
    .filter((f) => f.amountIn > 0n && created.get(f.intent)?.inputMint === inputMint && created.get(f.intent)?.outputMint === outputMint)
    .slice(0, ESTIMATE_FILLS);
}

const byRate = (fills: Fill[]): Fill[] =>
  [...fills].sort((a, b) => (a.delivered * b.amountIn < b.delivered * a.amountIn ? -1 : a.delivered * b.amountIn > b.delivered * a.amountIn ? 1 : 0));

export const bestOf = (fills: Fill[]): Fill | undefined => byRate(fills).at(-1);

export const medianOf = (fills: Fill[]): Fill | undefined => byRate(fills)[Math.floor((fills.length - 1) / 2)];

export function openingAsk(fills: Fill[], amount: bigint, floor: bigint): bigint {
  const typical = medianOf(fills);
  const blind = (floor * (10_000n + SWAP_BLIND_BPS)) / 10_000n;
  const seen = typical === undefined ? 0n : (amount * typical.delivered * (10_000n + SWAP_HEADROOM_BPS)) / (typical.amountIn * 10_000n);
  const cap = (floor * SWAP_CAP_BPS) / 10_000n;
  const ask = seen > blind ? seen : blind;
  return ask < cap ? ask : cap;
}

export type Fill = { intent: Address; amountIn: bigint; delivered: bigint; signature: string; blockTime: bigint | null };

export type Pair = { inputMint: Address; outputMint: Address };

async function engineHistory(transport: Transport, limit: number) {
  return historyIn(await transport.engineTransactions(limit));
}

export function historyIn(transactions: readonly EngineTransaction[]) {
  const created = new Map<Address, Pair>();
  const fills: Fill[] = [];
  const ended = new Map<Address, "cancelled" | "expired">();
  let unread = 0;
  for (const tx of transactions) {
    if (tx.unread === true) {
      unread += 1;
    }
    if (tx.failed) {
      continue;
    }
    const begun = new Map<Address, bigint>();
    for (const event of tx.emitted.map(decodeEvent)) {
      if (event === null) {
        continue;
      }
      const fields = event.fields as Record<string, unknown>;
      const intent = fields["intent"] as Address;
      if (event.name === "IntentCreated") {
        created.set(intent, { inputMint: fields["inputMint"] as Address, outputMint: fields["outputMint"] as Address });
      }
      if (event.name === "FillBegun") {
        begun.set(intent, fields["amountIn"] as bigint);
      }
      const amountIn = event.name === "IntentFilled" ? (fields["amountIn"] as bigint) : event.name === "FillEnded" ? begun.get(intent) : undefined;
      if (amountIn !== undefined) {
        fills.push({ intent, amountIn, delivered: fields["delivered"] as bigint, signature: tx.signature, blockTime: tx.blockTime });
      }
      if (event.name === "IntentCancelled" || event.name === "IntentExpired") {
        ended.set(intent, event.name === "IntentCancelled" ? "cancelled" : "expired");
      }
    }
  }
  return { created, fills, ended, unread };
}

export function pairOf(data: Uint8Array): Pair | null {
  try {
    const { inputMint, outputMint } = getIntentDecoder().decode(data);
    return { inputMint, outputMint };
  } catch {
    return null;
  }
}
