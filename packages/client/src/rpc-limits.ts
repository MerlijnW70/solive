import type { RpcTransport } from "@solana/kit";
import { InvalidInput, SdkError } from "@intent-engine/core";
import { rateLimited, retryAfterOf, unissued } from "./rpc-retry.js";
import { scopedStop } from "./stop-scope.js";

export class RateLimited extends SdkError {
  readonly code = "rate-limited";
  override readonly name = "RateLimited";
  readonly method: string;
  readonly retryAfterMs: number | null;

  constructor(method: string, retryAfterMs: number | null, options?: ErrorOptions) {
    super(
      retryAfterMs === null ? `the node rate limited ${method}; read again later` : `the node rate limited ${method}; read again after ${retryAfterMs} ms`,
      options,
    );
    this.method = method;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimedOut extends SdkError {
  readonly code = "timed-out";
  override readonly name = "TimedOut";
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number, options?: ErrorOptions) {
    super(`the node did not answer ${method} within ${timeoutMs} ms`, options);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class Cancelled extends SdkError {
  readonly code = "cancelled";
  override readonly name = "Cancelled";
  readonly method: string;

  constructor(method: string, options?: ErrorOptions) {
    super(`${method} was cancelled by the client's signal`, options);
    this.method = method;
  }
}

export class ReplyTooLarge extends SdkError {
  readonly code = "reply-too-large";
  override readonly name = "ReplyTooLarge";
  readonly method: string;
  readonly maxReplyBytes: number;

  constructor(method: string, maxReplyBytes: number, options?: ErrorOptions) {
    super(`the node answered ${method} with more than ${maxReplyBytes} bytes, so the reply was refused`, options);
    this.method = method;
    this.maxReplyBytes = maxReplyBytes;
  }
}

export class WrongReplyLength extends SdkError {
  readonly code = "wrong-reply-length";
  override readonly name = "WrongReplyLength";
  readonly method: string;
  readonly asked: number;
  readonly answered: number | null;

  constructor(method: string, asked: number, answered: number | null, options?: ErrorOptions) {
    super(`the node answered ${method} for ${asked} entries with ${answered === null ? "no list" : `${answered} entries`}, so the reply was refused`, options);
    this.method = method;
    this.asked = asked;
    this.answered = answered;
  }
}

export function answeredEach<T>(method: string, asked: number, value: readonly T[]): readonly T[] {
  const answered = Array.isArray(value) ? value.length : null;
  if (answered !== asked) {
    throw new WrongReplyLength(method, asked, answered);
  }
  return value;
}

export const TIMEOUT_RANGE ="timeoutMs must be a whole number of milliseconds from 1 to 2147483647";

const TIMEOUT_MAX = 2_147_483_647;

export const REPLY_CAP_RANGE = "maxReplyBytes must be a whole number of bytes from 1 to 2147483647";

const REPLY_CAP_MAX = 2_147_483_647;

export function checkedLimits(timeoutMs: unknown, retry: unknown, signal: unknown = undefined, maxReplyBytes: unknown = undefined, rpcTransport: unknown = undefined): void {
  if (maxReplyBytes !== undefined && (typeof maxReplyBytes !== "number" || !Number.isInteger(maxReplyBytes) || maxReplyBytes < 1 || maxReplyBytes > REPLY_CAP_MAX)) {
    throw new InvalidInput("maxReplyBytes", "range", REPLY_CAP_RANGE);
  }
  if (maxReplyBytes !== undefined && rpcTransport !== undefined) {
    throw new InvalidInput("maxReplyBytes", "conflict", "maxReplyBytes caps the transport built from url, so it cannot be combined with rpcTransport");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new InvalidInput("signal", "format", "signal must be an AbortSignal");
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MAX)) {
    throw new InvalidInput("timeoutMs", "range", TIMEOUT_RANGE);
  }
  if (retry !== undefined && typeof retry !== "boolean") {
    throw new InvalidInput("retry", "format", "retry must be true or false");
  }
}

export async function unretried<T>(method: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (rateLimited(error)) {
      throw new RateLimited(method, retryAfterOf(error) ?? null, { cause: error });
    }
    throw error;
  }
}

const METHOD = /^[A-Za-z]{1,64}$/;

export function methodOf(payload: unknown): string {
  const method = typeof payload === "object" && payload !== null ? (payload as { method?: unknown }).method : undefined;
  return typeof method === "string" && METHOD.test(method) ? method : "unknown";
}

function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) {
      stop();
    }
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

export const waitUnless =
  (signal: AbortSignal) =>
  (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) {
        done();
      }
    });

export function limitedTransport(base: RpcTransport, timeoutMs: number | undefined, stop: AbortSignal | undefined): RpcTransport {
  const limited = async (config: Parameters<RpcTransport>[0]) => {
    const method = methodOf(config.payload);
    const scoped = scopedStop();
    const stops = [stop, scoped].filter((signal) => signal !== undefined);
    const stopped = (): boolean => stops.some((signal) => signal.aborted);
    if (stopped()) {
      throw unissued(new Cancelled(method, { cause: stops.find((signal) => signal.aborted)?.reason }));
    }
    const timer = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const ending = [timer, ...stops].filter((signal) => signal !== undefined);
    const work = base({ ...config, signal: AbortSignal.any([...ending, ...(config.signal === undefined ? [] : [config.signal])]) });
    work.catch(() => undefined);
    try {
      return await raced(work, AbortSignal.any(ending));
    } catch (error) {
      if (stopped()) {
        throw new Cancelled(method, { cause: error });
      }
      if (timer?.aborted === true && timeoutMs !== undefined) {
        throw new TimedOut(method, timeoutMs, { cause: error });
      }
      throw error;
    }
  };
  return limited as RpcTransport;
}
