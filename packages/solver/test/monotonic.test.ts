import type { Address, Blockhash } from "@solana/kit";
import type { Config, Intent } from "@intent-engine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoff, type Chain, CONFIG_TTL_MS, remembering } from "../src/index.js";

const ACCOUNT = "11111111111111111111111111111112" as Address;
const INTENT = { amountIn: 1n } as unknown as Intent;
const DAY_MS = 86_400_000;

function counted() {
  const calls = { config: 0 };
  const chain: Chain = {
    config: async () => {
      calls.config += 1;
      return { feeBps: calls.config } as unknown as Config;
    },
    intents: async () => [],
    now: async () => 0n,
    tokenProgram: async () => ACCOUNT,
    exists: async () => true,
    lookupTables: async () => ({}),
    blockhash: async () => ({ blockhash: "1" as Blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => 0n,
  };
  return { calls, chain };
}

function steppingWall(): void {
  const real = Date.now.bind(Date);
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => {
    calls += 1;
    return real() + (calls % 2 === 0 ? DAY_MS : -DAY_MS);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("solver waits that start and end in one process", () => {
  it("keep the config for its lifetime by the clock given, whatever the wall clock does", async () => {
    steppingWall();
    const { calls, chain } = counted();
    let at = 0;
    const remembered = remembering(chain, () => at);
    await remembered.config();
    at = CONFIG_TTL_MS;
    await remembered.config();
    expect(calls.config).toBe(1);
    at = CONFIG_TTL_MS + 1;
    await remembered.config();
    expect(calls.config).toBe(2);
  });

  it("back off a failed fill for its interval by the clock given, whatever the wall clock does", () => {
    steppingWall();
    let at = 0;
    const held = backoff(3, () => at);
    held.failed(ACCOUNT, INTENT);
    expect(held.waiting(ACCOUNT, INTENT)).toEqual({ failures: 1, seconds: 3 });
    at = 2_500;
    expect(held.waiting(ACCOUNT, INTENT)).toEqual({ failures: 1, seconds: 1 });
    at = 3_000;
    expect(held.waiting(ACCOUNT, INTENT)).toBeNull();
  });

  it("read performance.now by default, never the wall clock", async () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    const mono = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { calls, chain } = counted();
    const remembered = remembering(chain);
    const held = backoff(3);
    await remembered.config();
    held.failed(ACCOUNT, INTENT);
    wall.mockReturnValue(DAY_MS);
    await remembered.config();
    expect(calls.config).toBe(1);
    expect(held.waiting(ACCOUNT, INTENT)).toEqual({ failures: 1, seconds: 3 });
    mono.mockReturnValue(1_000 + CONFIG_TTL_MS + 1);
    await remembered.config();
    expect(calls.config).toBe(2);
    expect(held.waiting(ACCOUNT, INTENT)).toBeNull();
    expect(wall).not.toHaveBeenCalled();
  });
});
