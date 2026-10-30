import { CALLER_DRIPS, DRIP_WINDOW_SECS } from "./limits.js";

export type Reservation = { readonly ok: true; release: () => void } | { readonly ok: false; readonly retryAfter: number };

export class CallerLimit {
  readonly #drips = new Map<string, number[]>();
  readonly #pending = new Set<string>();

  hold(address: string): (() => void) | undefined {
    if (this.#pending.has(address)) return undefined;
    this.#pending.add(address);
    return () => void this.#pending.delete(address);
  }

  constructor(
    readonly limit: number = CALLER_DRIPS,
    readonly windowSecs: number = DRIP_WINDOW_SECS,
  ) {}

  reserve(caller: string, nowMs: number): Reservation {
    const windowMs = this.windowSecs * 1000;
    const recent = (this.#drips.get(caller) ?? []).filter((at) => nowMs - at < windowMs);
    const oldest = recent[0];
    if (recent.length >= this.limit && oldest !== undefined) {
      this.#drips.set(caller, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)) };
    }
    recent.push(nowMs);
    this.#drips.set(caller, recent);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const list = this.#drips.get(caller) ?? [];
        const at = list.indexOf(nowMs);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) this.#drips.delete(caller);
      },
    };
  }

  forget(nowMs: number): void {
    const windowMs = this.windowSecs * 1000;
    for (const [caller, list] of this.#drips) {
      const recent = list.filter((at) => nowMs - at < windowMs);
      if (recent.length === 0) this.#drips.delete(caller);
      else this.#drips.set(caller, recent);
    }
  }
}
