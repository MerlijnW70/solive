import type { Address } from "@solana/kit";
import type { IssueRoute } from "./issue.js";
import type { Pricer, Quote, QuoteRequest } from "./market.js";

export type Holdings = (mint: Address) => Promise<bigint>;

export type Stock = Map<Address, { start: bigint; spent: bigint }>;

export function stockLeft(stock: Stock, account: Address, live: bigint): bigint {
  const held = stock.get(account);
  if (held === undefined) {
    return live;
  }
  const left = held.start - held.spent;
  return left < live ? left : live;
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
