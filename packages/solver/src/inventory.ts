import { type Address, getAddressDecoder } from "@solana/kit";
import { least } from "./amounts.js";
import type { IssueRoute } from "./issue.js";
import type { Pricer, Quote, QuoteRequest } from "./market.js";

export type Holdings = (mint: Address) => Promise<bigint>;

export type Stock = Map<Address, { start: bigint; spent: bigint }>;

export const TOKEN_ACCOUNT_BASE = 165;

const DELEGATE_TAG = 72;

const DELEGATE_KEY = 76;

const DELEGATED_AMOUNT = 121;

export function allowanceOf(data: Uint8Array | null, delegate: Address): bigint {
  if (data === null || data.length < TOKEN_ACCOUNT_BASE) {
    return 0n;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(DELEGATE_TAG, true) !== 1) {
    return 0n;
  }
  if (getAddressDecoder().decode(data.subarray(DELEGATE_KEY, DELEGATE_KEY + 32)) !== delegate) {
    return 0n;
  }
  return view.getBigUint64(DELEGATED_AMOUNT, true);
}

export const spendable = (balance: bigint, allowance: bigint): bigint => least(allowance, balance);

export function stockLeft(stock: Stock, account: Address, live: bigint): bigint {
  const held = stock.get(account);
  if (held === undefined) {
    return live;
  }
  return least(held.start - held.spent, live);
}

export function spend(stock: Stock, account: Address, live: bigint, amount: bigint): void {
  const held = stock.get(account) ?? { start: live, spent: 0n };
  stock.set(account, { start: held.start, spent: held.spent + amount });
}

export function inventoryPricer(routes: readonly IssueRoute[], held: Holdings): Pricer {
  for (const route of routes) {
    if (route.out <= 0n || route.in <= 0n) {
      throw new RangeError(`the inventory rate for ${route.outputMint} must be positive on both sides`);
    }
  }
  return {
    async quote(request: QuoteRequest): Promise<Quote | null> {
      const route = routes.find((r) => r.inputMint === request.inputMint && r.outputMint === request.outputMint);
      if (route === undefined) {
        return null;
      }
      const amountOut = (request.amountIn * route.out) / route.in;
      if ((await held(route.outputMint)) < amountOut) {
        return null;
      }
      return { amountIn: request.amountIn, amountOut, instructions: [], lookupTables: [], inventory: true };
    },
  };
}
