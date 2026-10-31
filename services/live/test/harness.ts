import type { RpcTransport } from "@solana/kit";
import type { Env } from "../src/env.js";
import { liveFeed } from "../src/http.js";
import { LIMITS, type Limits } from "../src/limits.js";
import type { Probe } from "../src/services.js";
import type { RuntimeCache } from "../src/store.js";
import { FakeNode } from "./fake-node.js";

export const NOW = Date.parse("2026-10-31T06:00:00Z");
export const HOUR_SECS = 3600;
export const nowSecs = (offset = 0): number => Math.floor(NOW / 1000) + offset;

export class MemoryCache implements RuntimeCache {
  readonly values = new Map<string, unknown>();
  sets = 0;
  broken = false;

  async get(key: string): Promise<unknown> {
    if (this.broken) {
      throw new Error("cache down");
    }
    return this.values.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.broken) {
      throw new Error("cache down");
    }
    this.sets += 1;
    this.values.set(key, value);
  }
}

export type Clock = { at: number };

export type Rig = {
  node: FakeNode;
  cache: MemoryCache;
  clock: Clock;
  logs: string[];
  probes: number;
};

export type RigOptions = { env?: Env; limits?: Partial<Limits>; probe?: Probe; transport?: RpcTransport };

export function rig(options: RigOptions = {}, shared?: Rig) {
  const node = shared?.node ?? new FakeNode();
  const cache = shared?.cache ?? new MemoryCache();
  const clock = shared?.clock ?? { at: NOW };
  const logs = shared?.logs ?? [];
  const state: Rig = { node, cache, clock, logs, probes: 0 };
  const probe: Probe =
    options.probe ??
    (async () => {
      state.probes += 1;
      return 405;
    });
  const feed = liveFeed({
    env: options.env ?? {},
    cache: () => cache,
    transport: options.transport ?? node.transport,
    probe,
    limits: { ...LIMITS, ...options.limits },
    now: () => clock.at,
    log: (line) => logs.push(line),
  });
  return { ...state, feed, tick: (secs: number) => (clock.at += secs * 1000) };
}
