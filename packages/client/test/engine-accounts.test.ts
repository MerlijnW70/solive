import { type Address, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";
import type { RpcLike } from "../src/internal.js";
import { rpcTransport } from "../src/rpc-transport.js";
import { signatureOfWire } from "./transport-stub.js";

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

const request = (filters: unknown[]) => ({ program: INTENT_ENGINE_PROGRAM_ADDRESS, config: { encoding: "base64", commitment: "confirmed", filters, withContext: true } });

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

  it("sends each field to match as an address at its offset after the discriminator", async () => {
    const s = scan();
    await s.engineAccounts?.({ discriminator, dataSize: 77, match: [{ offset: 8, address: ACCOUNT }, { offset: 40, address: INTENT_ENGINE_PROGRAM_ADDRESS }] });
    expect(s.asked).toEqual([
      request([
        { dataSize: 77n },
        { memcmp: { offset: 0n, bytes, encoding: "base58" } },
        { memcmp: { offset: 8n, bytes: ACCOUNT, encoding: "base58" } },
        { memcmp: { offset: 40n, bytes: INTENT_ENGINE_PROGRAM_ADDRESS, encoding: "base58" } },
      ]),
    ]);
  });

  it("sends only the discriminator when the size is not fixed", async () => {
    const s = scan();
    await s.engineAccounts?.({ discriminator });
    expect(s.asked).toEqual([request([{ memcmp: { offset: 0n, bytes, encoding: "base58" } }])]);
  });
});

function confirmingAt(confirmed: bigint, answered: bigint[]) {
  const seen: (bigint | undefined)[] = [];
  const waits: number[] = [];
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: ACCOUNT, lastValidBlockHeight: 10n } }) }),
    sendTransaction: (wire: string) => ({ send: async () => signatureOfWire(wire) }),
    getSignatureStatuses: () => ({ send: async () => ({ context: { slot: confirmed }, value: [{ err: null, confirmationStatus: "confirmed", slot: confirmed }] }) }),
    getProgramAccounts: (_program: Address, config: { minContextSlot?: bigint; withContext?: true }) => ({
      send: async () => {
        seen.push(config.withContext === true ? config.minContextSlot : -1n);
        return { context: { slot: answered.shift() ?? confirmed }, value: [] };
      },
    }),
  } as unknown as RpcLike;
  const transport = rpcTransport(rpc, async (ms) => {
    waits.push(ms);
  });
  return { transport, seen, waits };
}

describe("engine accounts after a write", () => {
  it("reads with context no older than the client's last confirmed write, and retries a node that answers from behind", async () => {
    const before = confirmingAt(50n, []);
    await before.transport.engineAccounts?.({ discriminator: new Uint8Array(8) });
    expect(before.seen).toEqual([undefined]);
    const after = confirmingAt(50n, [40n, 50n]);
    await after.transport.send([], await generateKeyPairSigner());
    expect(await after.transport.engineAccounts?.({ discriminator: new Uint8Array(8), match: [{ offset: 8, address: ACCOUNT }] })).toEqual([]);
    expect(after.seen).toEqual([50n, 50n]);
    expect(after.waits).toHaveLength(1);
  });
});
