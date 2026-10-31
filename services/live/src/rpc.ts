import { isSolanaError, type RpcTransport, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { RETRY_AFTER_DEFAULT_SECS } from "./limits.js";

export class RateLimited extends Error {
  override readonly name = "RateLimited";
  readonly retryAfterSecs: number;
  readonly method: string;

  constructor(retryAfterSecs: number, method = "unknown") {
    super("the node asked the feed to wait before its next read");
    this.retryAfterSecs = retryAfterSecs;
    this.method = method;
  }
}

export class ReadTimedOut extends Error {
  override readonly name = "ReadTimedOut";

  constructor() {
    super("a read from the node ran out of time");
  }
}

export class ReadFailed extends Error {
  override readonly name = "ReadFailed";

  constructor(readonly status: number | null) {
    super(status === null ? "a read from the node failed" : `a read from the node failed with status ${status}`);
  }
}

const SECONDS = /^\d{1,9}$/;

export function retryAfterSecs(value: string | null | undefined, now: number): number {
  const text = value?.trim() ?? "";
  if (SECONDS.test(text)) {
    return Math.max(1, Number(text));
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? RETRY_AFTER_DEFAULT_SECS : Math.max(1, Math.ceil((at - now) / 1000));
}

export function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new ReadTimedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ReadTimedOut());
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

function headerOf(headers: unknown, name: string): string | null {
  return headers instanceof Headers ? headers.get(name) : null;
}

export function translated(error: unknown, signal: AbortSignal, now: number, method = "unknown"): Error {
  if (error instanceof RateLimited || error instanceof ReadTimedOut || error instanceof ReadFailed) {
    return error;
  }
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const { statusCode, headers } = error.context;
    return statusCode === 429 ? new RateLimited(retryAfterSecs(headerOf(headers, "retry-after"), now), method) : new ReadFailed(statusCode);
  }
  return signal.aborted ? new ReadTimedOut() : new ReadFailed(null);
}

const METHOD = /^[A-Za-z]{1,64}$/;

function methodOf(payload: unknown): string {
  const method = typeof payload === "object" && payload !== null ? (payload as { method?: unknown }).method : undefined;
  return typeof method === "string" && METHOD.test(method) ? method : "unknown";
}

export function guardedTransport(base: RpcTransport, callTimeoutMs: number, deadline: AbortSignal, now: () => number = Date.now): RpcTransport {
  const guarded = async (config: Parameters<RpcTransport>[0]) => {
    const signal = AbortSignal.any([AbortSignal.timeout(callTimeoutMs), deadline, ...(config.signal === undefined ? [] : [config.signal])]);
    try {
      return await raced(base({ ...config, signal }), signal);
    } catch (error) {
      throw translated(error, signal, now(), methodOf(config.payload));
    }
  };
  return guarded as RpcTransport;
}
