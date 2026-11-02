import { PUT_WINDOW_SECS, PUTS_PER_WINDOW } from "./limits.js";

export class CallerLimit {
  readonly #puts = new Map<string, number[]>();

  constructor(
    readonly limit: number = PUTS_PER_WINDOW,
    readonly windowSecs: number = PUT_WINDOW_SECS,
  ) {}

  retryAfter(caller: string, nowMs: number): number | null {
    const windowMs = this.windowSecs * 1000;
    const recent = (this.#puts.get(caller) ?? []).filter((at) => nowMs - at < windowMs);
    const oldest = recent[0];
    if (recent.length >= this.limit && oldest !== undefined) {
      this.#puts.set(caller, recent);
      return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    }
    recent.push(nowMs);
    this.#puts.set(caller, recent);
    return null;
  }

  forget(nowMs: number): void {
    const windowMs = this.windowSecs * 1000;
    for (const [caller, list] of this.#puts) {
      const recent = list.filter((at) => nowMs - at < windowMs);
      if (recent.length === 0) this.#puts.delete(caller);
      else this.#puts.set(caller, recent);
    }
  }
}
