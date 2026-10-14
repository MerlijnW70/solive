import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";

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

export async function patiently<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(rateLimited(error) || behindMinSlot(error)) || attempt >= RATE_LIMIT_ATTEMPTS) {
        throw error;
      }
      await wait(POLL_MS * 2 ** attempt);
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
  constructor(message: string) {
    super(message);
    this.name = "BlockhashExpired";
  }
}

export const neverLanded = (error: unknown): boolean => error instanceof FailedOnChain || error instanceof BlockhashExpired;
