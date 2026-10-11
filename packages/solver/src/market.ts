import type { Address, Instruction } from "@solana/kit";

export type QuoteRequest = {
  inputMint: Address;
  outputMint: Address;
  amountIn: bigint;
  taker: Address;
  maxAccounts?: number;
};

export type Quote = {
  amountIn: bigint;
  amountOut: bigint;
  instructions: Instruction[];
  lookupTables: Address[];
};

export interface Pricer {
  quote(request: QuoteRequest): Promise<Quote | null>;
}

export type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;
