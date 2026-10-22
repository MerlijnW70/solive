import { type Address, getBase58Decoder } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import type { RpcLike } from "../src/index.js";
import { rpcTransport } from "../src/rpc-transport.js";

const ACCOUNT = "11111111111111111111111111111112" as Address;

function scan() {
  const asked: unknown[] = [];
  const rpc = {
    getProgramAccounts: (program: Address, config: unknown) => ({
      send: async () => {
        asked.push({ program, config });
        return [{ pubkey: ACCOUNT, account: { data: [Buffer.from([1, 2]).toString("base64"), "base64"] as const, lamports: 3n } }];
      },
    }),
  } as unknown as RpcLike;
  return { asked, engineAccounts: rpcTransport(rpc, async () => {}).engineAccounts };
}

const request = (filters: unknown[]) => ({ program: INTENT_ENGINE_PROGRAM_ADDRESS, config: { encoding: "base64", commitment: "confirmed", filters } });

describe("engine account filters", () => {
  const discriminator = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const bytes = getBase58Decoder().decode(discriminator);

  it("sends no filter when none is given", async () => {
    const s = scan();
    expect(await s.engineAccounts?.()).toEqual([{ address: ACCOUNT, data: new Uint8Array([1, 2]), lamports: 3n }]);
    expect(s.asked).toEqual([request([])]);
  });

  it("sends the data size and the discriminator at offset zero", async () => {
    const s = scan();
    await s.engineAccounts?.({ discriminator, dataSize: 77 });
    expect(s.asked).toEqual([request([{ dataSize: 77n }, { memcmp: { offset: 0n, bytes, encoding: "base58" } }])]);
  });

  it("sends only the discriminator when the size is not fixed", async () => {
    const s = scan();
    await s.engineAccounts?.({ discriminator });
    expect(s.asked).toEqual([request([{ memcmp: { offset: 0n, bytes, encoding: "base58" } }])]);
  });
});
