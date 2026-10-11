import type { Address, Blockhash } from "@solana/kit";
import type { Config } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { BLOCKHASH_TTL_MS, type Chain, CONFIG_TTL_MS, remembering } from "../src/index.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ACCOUNT = "11111111111111111111111111111112" as Address;

function counted() {
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return calls[name];
  };
  let present = false;
  let failing = false;
  const chain: Chain = {
    config: async () => ({ feeBps: count("config") }) as unknown as Config,
    intents: async () => {
      count("intents");
      return [];
    },
    now: async () => BigInt(count("now")),
    tokenProgram: async () => {
      count("tokenProgram");
      if (failing) {
        throw new Error("rpc down");
      }
      return PROGRAM;
    },
    exists: async () => {
      count("exists");
      return present;
    },
    lookupTables: async () => ({}),
    blockhash: async () => ({ blockhash: String(count("blockhash")) as Blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => BigInt(count("tokenAmount")),
  };
  return {
    calls,
    chain,
    appear: () => {
      present = true;
    },
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

describe("a remembering chain", () => {
  it("asks once for what never changes and every time for what does", async () => {
    let clock = 0;
    const source = counted();
    const chain = remembering(source.chain, () => clock);
    expect(await Promise.all([chain.tokenProgram(MINT), chain.tokenProgram(MINT)])).toEqual([PROGRAM, PROGRAM]);
    expect(await chain.exists(ACCOUNT)).toBe(false);
    expect(await chain.exists(ACCOUNT)).toBe(false);
    source.appear();
    expect(await chain.exists(ACCOUNT)).toBe(true);
    expect(await chain.exists(ACCOUNT)).toBe(true);
    await chain.intents();
    await chain.intents();
    await chain.now();
    await chain.now();
    await chain.tokenAmount(ACCOUNT);
    await chain.tokenAmount(ACCOUNT);
    expect(source.calls).toEqual({ tokenProgram: 1, exists: 3, intents: 2, now: 2, tokenAmount: 2 });
  });

  it("keeps the config and blockhash only while they are fresh", async () => {
    let clock = 0;
    const source = counted();
    const chain = remembering(source.chain, () => clock);
    expect((await chain.config()).feeBps).toBe(1);
    expect((await chain.blockhash()).blockhash).toBe("1");
    clock = BLOCKHASH_TTL_MS;
    expect([(await chain.config()).feeBps, (await chain.blockhash()).blockhash]).toEqual([1, "1"]);
    clock = BLOCKHASH_TTL_MS + 1;
    expect([(await chain.config()).feeBps, (await chain.blockhash()).blockhash]).toEqual([1, "2"]);
    clock = CONFIG_TTL_MS + 1;
    expect((await chain.config()).feeBps).toBe(2);
  });

  it("forgets everything on request and never keeps a failed answer", async () => {
    const source = counted();
    const chain = remembering(source.chain, () => 0);
    source.fail(true);
    await expect(chain.tokenProgram(MINT)).rejects.toThrow("rpc down");
    source.fail(false);
    expect(await chain.tokenProgram(MINT)).toBe(PROGRAM);
    source.appear();
    await chain.exists(ACCOUNT);
    await chain.config();
    await chain.blockhash();
    chain.forget();
    await chain.tokenProgram(MINT);
    await chain.exists(ACCOUNT);
    await chain.config();
    await chain.blockhash();
    expect(source.calls).toMatchObject({ tokenProgram: 3, exists: 2, config: 2, blockhash: 2 });
  });
});
