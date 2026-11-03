import { CALLER_CHECKS, CALLER_DRIPS, CHECK_WINDOW_SECS, DAILY_DRIPS, DRIP_WINDOW_SECS, RECIPIENT_MEMORY_SECS } from "./limits.js";

export type Reservation = { readonly ok: true; release: () => void } | { readonly ok: false; readonly retryAfter: number };

export type Spend = { readonly ok: true } | { readonly ok: false; readonly retryAfter: number };

export type Refusal = "recent" | "busy";

export type Recalled = { readonly reason: Refusal; readonly retryAfter: number };

type Remembered = { readonly reason: Refusal; readonly retryAt: number; readonly until: number };

const within = (list: readonly number[], nowMs: number, windowMs: number): number[] => list.filter((at) => nowMs - at < windowMs);

const waitSecs = (untilMs: number, nowMs: number): number => Math.max(1, Math.ceil((untilMs - nowMs) / 1000));

function take(map: Map<string, number[]>, key: string, limit: number, windowMs: number, nowMs: number): Reservation {
  const recent = within(map.get(key) ?? [], nowMs, windowMs);
  const oldest = recent[0];
  if (recent.length >= limit && oldest !== undefined) {
    map.set(key, recent);
    return { ok: false, retryAfter: waitSecs(oldest + windowMs, nowMs) };
  }
  recent.push(nowMs);
  map.set(key, recent);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const list = map.get(key) ?? [];
      const at = list.indexOf(nowMs);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) map.delete(key);
    },
  };
}

export class CallerLimit {
  readonly #drips = new Map<string, number[]>();
  readonly #sends = new Map<string, number[]>();
  readonly #checks = new Map<string, number[]>();
  readonly #pending = new Set<string>();
  readonly #recipients = new Map<string, Remembered>();

  hold(address: string): (() => void) | undefined {
    if (this.#pending.has(address)) return undefined;
    this.#pending.add(address);
    return () => void this.#pending.delete(address);
  }

  constructor(
    readonly limit: number = CALLER_DRIPS,
    readonly windowSecs: number = DRIP_WINDOW_SECS,
    readonly checks: number = CALLER_CHECKS,
    readonly checkWindowSecs: number = CHECK_WINDOW_SECS,
    readonly sends: number = DAILY_DRIPS,
  ) {}

  reserve(caller: string, nowMs: number): Reservation {
    return take(this.#drips, caller, this.limit, this.windowSecs * 1000, nowMs);
  }

  reserveSend(nowMs: number): Reservation {
    return take(this.#sends, "", this.sends, this.windowSecs * 1000, nowMs);
  }

  spend(caller: string, nowMs: number): Spend {
    const windowMs = this.checkWindowSecs * 1000;
    const recent = within(this.#checks.get(caller) ?? [], nowMs, windowMs);
    const oldest = recent[0];
    if (recent.length >= this.checks && oldest !== undefined) {
      this.#checks.set(caller, recent);
      return { ok: false, retryAfter: waitSecs(oldest + windowMs, nowMs) };
    }
    recent.push(nowMs);
    this.#checks.set(caller, recent);
    return { ok: true };
  }

  remember(address: string, reason: Refusal, retryAt: number, nowMs: number): void {
    const until = Math.min(retryAt, nowMs + RECIPIENT_MEMORY_SECS * 1000);
    if (until > nowMs) this.#recipients.set(address, { reason, retryAt, until });
  }

  recall(address: string, nowMs: number): Recalled | undefined {
    const known = this.#recipients.get(address);
    if (known === undefined) return undefined;
    if (nowMs >= known.until) {
      this.#recipients.delete(address);
      return undefined;
    }
    return { reason: known.reason, retryAfter: waitSecs(known.retryAt, nowMs) };
  }

  forget(nowMs: number): void {
    const prune = (map: Map<string, number[]>, windowMs: number) => {
      for (const [caller, list] of map) {
        const recent = within(list, nowMs, windowMs);
        if (recent.length === 0) map.delete(caller);
        else map.set(caller, recent);
      }
    };
    prune(this.#drips, this.windowSecs * 1000);
    prune(this.#sends, this.windowSecs * 1000);
    prune(this.#checks, this.checkWindowSecs * 1000);
    for (const [address, known] of this.#recipients) if (nowMs >= known.until) this.#recipients.delete(address);
  }
}
