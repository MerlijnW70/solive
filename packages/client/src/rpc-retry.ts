import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND } from "@solana/kit";

export const POLL_MS = 500;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const RATE_LIMIT_ATTEMPTS = 6;

const CAUSE_DEPTH = 8;

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let link = error; link instanceof Error && chain.length < CAUSE_DEPTH; link = link.cause) {
    chain.push(link);
  }
  return chain;
}

const said = (chain: readonly Error[], text: RegExp): boolean => chain.some((link) => !isSolanaError(link) && text.test(link.message));

export function rateLimited(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof Charged) {
    return false;
  }
  const chain = causes(error);
  for (const link of chain) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return link.context.statusCode === 429;
    }
  }
  return said(chain, /\b429\b/);
}

export const MIN_CONTEXT_SLOT_NOT_REACHED = -32016;

export function behindMinSlot(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof Charged) {
    return false;
  }
  const chain = causes(error);
  return chain.some((link) => isSolanaError(link, MIN_CONTEXT_SLOT_NOT_REACHED)) || said(chain, /-32016\b|minimum context slot/i);
}

export const backoffOf = (attempt: number): number => POLL_MS * 2 ** attempt;

export const RATE_LIMIT_BUDGET_MS = Array.from({ length: RATE_LIMIT_ATTEMPTS - 1 }, (_, at) => backoffOf(at + 1)).reduce((sum, ms) => sum + ms, 0);

const RETRY_AFTER_SECONDS = /^\d{1,9}$/;

export function retryAfterOf(error: unknown, now: number = Date.now()): number | undefined {
  for (const link of causes(error)) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      const headers: unknown = link.context.headers;
      const value = headers instanceof Headers ? headers.get("retry-after")?.trim() : undefined;
      if (value === undefined || value === "") {
        return undefined;
      }
      if (RETRY_AFTER_SECONDS.test(value)) {
        return Number(value) * 1000;
      }
      const at = Date.parse(value);
      return Number.isNaN(at) ? undefined : Math.max(0, at - now);
    }
  }
  return undefined;
}

export const jittered = (base: number, random: () => number): number => base - Math.floor(Math.min(Math.max(random(), 0), 1) * (base / 2));

export async function patiently<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep, random: () => number = Math.random): Promise<T> {
  let spent = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(rateLimited(error) || behindMinSlot(error)) || attempt >= RATE_LIMIT_ATTEMPTS) {
        throw error;
      }
      const delay = retryAfterOf(error) ?? jittered(backoffOf(attempt), random);
      if (spent + delay > RATE_LIMIT_BUDGET_MS) {
        throw error;
      }
      spent += delay;
      await wait(delay);
    }
  }
}

export class Charged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Charged";
  }
}

export class FailedOnChain extends Charged {}

export class BlockhashExpired extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlockhashExpired";
  }
}

export const neverLanded = (error: unknown): boolean => error instanceof FailedOnChain || error instanceof BlockhashExpired;

export const staleBlockhash = (error: unknown): boolean =>
  !(error instanceof Charged) && causes(error).some((link) => isSolanaError(link, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND));
