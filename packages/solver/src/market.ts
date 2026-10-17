import type { Address, Instruction } from "@solana/kit";

export type QuoteRequest = {
  inputMint: Address;
  outputMint: Address;
  amountIn: bigint;
  taker: Address;
  maxAccounts?: number;
  fresh?: boolean;
};

export type Quote = {
  amountIn: bigint;
  amountOut: bigint;
  instructions: Instruction[];
  lookupTables: Address[];
  inventory?: boolean;
};

export interface Pricer {
  quote(request: QuoteRequest): Promise<Quote | null>;
}

export function firstPricer(...pricers: readonly Pricer[]): Pricer {
  return {
    async quote(request: QuoteRequest): Promise<Quote | null> {
      for (const pricer of pricers) {
        const quote = await pricer.quote(request);
        if (quote !== null) {
          return quote;
        }
      }
      return null;
    },
  };
}

export type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;
