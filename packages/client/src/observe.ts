import type { Address, Signature } from "@solana/kit";
import { redactUrls } from "./redact-url.js";

export type RequestEvent = { id: number; method: string; attempt: number };

export type ResponseEvent = RequestEvent & { ms: number; error?: unknown };

export type RetryReason = "rate-limited" | "behind-min-slot";

export type RetryEvent = { method: string; attempt: number; delay: number; reason: RetryReason };

export type SendEvent = { signature: Signature; payer: Address; instructions: number; lastValidBlockHeight: bigint | null };

export type ConfirmOutcome = "confirmed" | "failed" | "expired" | "unknown";

export type ConfirmEvent = { signature: Signature; outcome: ConfirmOutcome; slot?: bigint; ms: number };

export type FetchEvent = { url: string; status: number | null; ms: number };

export type ClientEvents = {
  request: RequestEvent;
  response: ResponseEvent;
  retry: RetryEvent;
  send: SendEvent;
  confirm: ConfirmEvent;
  fetch: FetchEvent;
};

export type ClientEventName = keyof ClientEvents;

export type HookName = ClientEventName | "debug";

export type HookFailure = { hook: HookName; error: unknown };

export type ClientHooks = { [K in ClientEventName]?: (event: ClientEvents[K]) => unknown } & { error?: (failure: HookFailure) => unknown };

export type DebugLog = ((line: string) => unknown) | true;

export type Observer = {
  readonly quiet: boolean;
  request<T>(method: string, attempt: number, run: () => Promise<T>): Promise<T>;
  retry(event: RetryEvent): void;
  send(event: SendEvent): void;
  confirm(event: ConfirmEvent): void;
  fetch(event: FetchEvent): void;
};

export const QUIET: Observer = {
  quiet: true,
  request: (_method, _attempt, run) => run(),
  retry: () => undefined,
  send: () => undefined,
  confirm: () => undefined,
  fetch: () => undefined,
};

export const elapsedSince = (started: number): number => Math.round(performance.now() - started);

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function errorText(error: unknown): string {
  const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return oneLine(redactUrls(named));
}

const LINES: { [K in ClientEventName]: (event: ClientEvents[K]) => string } = {
  request: ({ id, method, attempt }) => `request #${id} ${method} attempt ${attempt}`,
  response: ({ id, method, attempt, ms, error }) =>
    `response #${id} ${method} attempt ${attempt} ${ms}ms${error === undefined ? "" : ` failed: ${errorText(error)}`}`,
  retry: ({ method, attempt, delay, reason }) => `retry ${method} after attempt ${attempt} in ${delay}ms: ${reason}`,
  send: ({ signature, payer, instructions, lastValidBlockHeight }) =>
    `send ${signature} payer ${payer} instructions ${instructions} lastValidBlockHeight ${lastValidBlockHeight ?? "none"}`,
  confirm: ({ signature, outcome, slot, ms }) => `confirm ${signature} ${outcome}${slot === undefined ? "" : ` slot ${slot}`} ${ms}ms`,
  fetch: ({ url, status, ms }) => `fetch ${url} ${status ?? "no response"} ${ms}ms`,
};

export const debugLine = <K extends ClientEventName>(name: K, event: ClientEvents[K]): string => oneLine(redactUrls(LINES[name](event)));

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

const EVENT_NAMES: readonly ClientEventName[] = ["request", "response", "retry", "send", "confirm", "fetch"];

export function observerOf(hooks: ClientHooks = {}, debug?: DebugLog): Observer {
  const write = debug === true ? (line: string) => console.debug(line) : debug;
  if (write === undefined && !EVENT_NAMES.some((name) => hooks[name] !== undefined)) {
    return QUIET;
  }
  const failed = (hook: HookName, error: unknown) => {
    try {
      const reported = hooks.error?.({ hook, error });
      if (thenable(reported)) {
        reported.then(undefined, () => undefined);
      }
    } catch {
      return;
    }
  };
  const guarded = (hook: HookName, run: () => unknown) => {
    try {
      const result = run();
      if (thenable(result)) {
        result.then(undefined, (error: unknown) => failed(hook, error));
      }
    } catch (error) {
      failed(hook, error);
    }
  };
  const emit = <K extends ClientEventName>(name: K, event: ClientEvents[K]) => {
    if (write !== undefined) {
      guarded("debug", () => write(debugLine(name, event)));
    }
    const hook = hooks[name] as ((event: ClientEvents[K]) => unknown) | undefined;
    if (hook !== undefined) {
      guarded(name, () => hook({ ...event }));
    }
  };
  let ids = 0;
  return {
    quiet: false,
    request: async (method, attempt, run) => {
      const id = ++ids;
      emit("request", { id, method, attempt });
      const started = performance.now();
      try {
        const value = await run();
        emit("response", { id, method, attempt, ms: elapsedSince(started) });
        return value;
      } catch (error) {
        emit("response", { id, method, attempt, ms: elapsedSince(started), error });
        throw error;
      }
    },
    retry: (event) => emit("retry", event),
    send: (event) => emit("send", event),
    confirm: (event) => emit("confirm", event),
    fetch: (event) => emit("fetch", event),
  };
}

export function joined(first: Observer, second: Observer): Observer {
  if (first.quiet) {
    return second;
  }
  if (second.quiet) {
    return first;
  }
  return {
    quiet: false,
    request: (method, attempt, run) => first.request(method, attempt, () => second.request(method, attempt, run)),
    retry: (event) => {
      first.retry(event);
      second.retry(event);
    },
    send: (event) => {
      first.send(event);
      second.send(event);
    },
    confirm: (event) => {
      first.confirm(event);
      second.confirm(event);
    },
    fetch: (event) => {
      first.fetch(event);
      second.fetch(event);
    },
  };
}
