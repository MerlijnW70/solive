import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__INVALID_REQUEST,
  SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__PARSE_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
} from "@solana/kit";
import { isSdkError, type SdkError } from "@intent-engine/core";
import type { RetryEvent } from "./observe.js";
import { scopedStop } from "./stop-scope.js";

export const POLL_MS = 500;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const stop = scopedStop();
    const done = () => {
      clearTimeout(timer);
      stop?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (stop !== undefined) {
      stop.addEventListener("abort", done, { once: true });
      if (stop.aborted) {
        done();
      }
    }
  });

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
  if (!(error instanceof Error) || isSdkError(error)) {
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
  if (isSdkError(error, "behind-min-slot")) {
    return true;
  }
  if (!(error instanceof Error) || isSdkError(error)) {
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

export type Retry = Omit<RetryEvent, "method">;

const UNISSUED = new WeakSet<object>();
const AFTER_ISSUED = new WeakSet<object>();

export async function patiently<T>(
  call: (attempt: number) => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
  random: () => number = Math.random,
  onRetry?: (retry: Retry) => void,
): Promise<T> {
  let spent = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(attempt);
    } catch (error) {
      if (attempt > 1 && typeof error === "object" && error !== null) {
        AFTER_ISSUED.add(error);
      }
      const limited = rateLimited(error);
      if (!(limited || behindMinSlot(error)) || attempt >= RATE_LIMIT_ATTEMPTS) {
        throw error;
      }
      if (scopedStop()?.aborted === true) {
        throw error;
      }
      const delay = retryAfterOf(error) ?? jittered(backoffOf(attempt), random);
      if (spent + delay > RATE_LIMIT_BUDGET_MS) {
        throw error;
      }
      spent += delay;
      onRetry?.({ attempt, delay, reason: limited ? "rate-limited" : "behind-min-slot" });
      await wait(delay);
      if (scopedStop()?.aborted === true) {
        throw error;
      }
    }
  }
}

export const neverLanded = (error: unknown): boolean => isSdkError(error, "failed-on-chain") || isSdkError(error, "blockhash-expired");

export const staleBlockhash = (error: unknown): boolean =>
  !isSdkError(error) && causes(error).some((link) => isSolanaError(link, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND));

const UNSENT_CODES: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const JSON_RPC_FIRST = -32_000;
const JSON_RPC_LAST = -32_768;

export const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 407, 411, 413, 414, 415, 421, 429, 431]);

export const REFUSED_RPC_CODES: ReadonlySet<number> = new Set([
  SOLANA_ERROR__JSON_RPC__PARSE_ERROR,
  SOLANA_ERROR__JSON_RPC__INVALID_REQUEST,
  SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
]);

export function unissued<E extends SdkError>(error: E): E {
  UNISSUED.add(error);
  return error;
}

export const afterIssued = (error: unknown): boolean => typeof error === "object" && error !== null && AFTER_ISSUED.has(error);

export function refusedUnsent(error: unknown): boolean {
  if (afterIssued(error)) {
    return false;
  }
  if (isSdkError(error)) {
    return UNISSUED.has(error) || (isSdkError(error, "rate-limited") && refusedUnsent(error.cause));
  }
  const chain = causes(error);
  if (chain.some((link) => isSolanaError(link, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED))) {
    return false;
  }
  for (const link of chain) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return REFUSED_STATUSES.has(link.context.statusCode);
    }
    if (isSolanaError(link) && link.context.__code <= JSON_RPC_FIRST && link.context.__code >= JSON_RPC_LAST) {
      return REFUSED_RPC_CODES.has(link.context.__code);
    }
    if (UNSENT_CODES.has((link as { code?: unknown }).code)) {
      return true;
    }
  }
  return false;
}
