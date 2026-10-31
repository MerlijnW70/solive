import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { isSdkError } from "@intent-engine/core";
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

export const retryAfterSecs = (retryAfterMs: number | null): number => (retryAfterMs === null ? RETRY_AFTER_DEFAULT_SECS : Math.max(1, Math.ceil(retryAfterMs / 1000)));

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

export function translated(error: unknown): unknown {
  if (error instanceof RateLimited || error instanceof ReadTimedOut || error instanceof ReadFailed) {
    return error;
  }
  if (isSdkError(error, "rate-limited")) {
    return new RateLimited(retryAfterSecs(error.retryAfterMs), error.method);
  }
  if (isSdkError(error, "timed-out") || isSdkError(error, "cancelled")) {
    return new ReadTimedOut();
  }
  if (isSdkError(error)) {
    return error;
  }
  return isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ? new ReadFailed(error.context.statusCode) : new ReadFailed(null);
}

export async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw translated(error);
  }
}
