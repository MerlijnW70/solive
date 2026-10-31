import { STATE_KEY } from "./limits.js";
import { emptyState, isState, type State } from "./shapes.js";

export type RuntimeCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
};

export class StateStore {
  private memory: string | null = null;
  private readonly cache: () => RuntimeCache | null;
  private readonly log: (line: string) => void;
  writes = 0;

  constructor(cache: () => RuntimeCache | null, log: (line: string) => void) {
    this.cache = cache;
    this.log = log;
  }

  private parsed(text: string | null): State | null {
    if (text === null) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(text);
      return isState(value) ? value : null;
    } catch {
      return null;
    }
  }

  async load(): Promise<State> {
    try {
      const found = await this.cache()?.get(STATE_KEY);
      const state = typeof found === "string" ? this.parsed(found) : null;
      if (state !== null && typeof found === "string") {
        this.memory = found;
        return state;
      }
    } catch (error) {
      this.log(JSON.stringify({ cache: "read failed", error: error instanceof Error ? error.name : "unknown" }));
    }
    return this.parsed(this.memory) ?? emptyState();
  }

  async save(state: State): Promise<boolean> {
    const text = JSON.stringify(state);
    if (text === this.memory) {
      return false;
    }
    this.memory = text;
    try {
      const cache = this.cache();
      if (cache !== null) {
        await cache.set(STATE_KEY, text);
        this.writes += 1;
      }
    } catch (error) {
      this.log(JSON.stringify({ cache: "write failed", error: error instanceof Error ? error.name : "unknown" }));
    }
    return true;
  }
}
