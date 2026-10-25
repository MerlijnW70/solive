import { type Address, getBase58Decoder, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import {
  type RpcLike,
  rpcTransport,
  TRANSACTION_FETCHES,
  KEPT_TRANSACTIONS,
} from "../src/transport.js";
import { isolateMocks, OTHER, OTHER_SIG, OWNER, SIG, stub } from "./transport-stub.js";

isolateMocks();

describe("intent scan", () => {
  it("asks for engine accounts of the intent size and discriminator at confirmed commitment and decodes them", async () => {
    const s = stub([]);
    const found = await rpcTransport(s.rpc, s.wait).intents();
    expect(found).toEqual([{ address: OWNER, data: new Uint8Array([7, 8]) }]);
    const filters = {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: getIntentSize().toString() },
        { memcmp: { offset: "0", bytes: getBase58Decoder().decode(getIntentDiscriminatorBytes()), encoding: "base58" } },
      ],
    };
    expect(s.calls).toEqual([`program-accounts:${INTENT_ENGINE_PROGRAM_ADDRESS}:${JSON.stringify(filters)}`]);
    expect(getIntentSize()).toBe(464);
  });

  it("lists every engine account with its lamports and no filter", async () => {
    const s = stub([]);
    const plain = await rpcTransport(s.rpc, s.wait).engineAccounts?.();
    expect(plain).toEqual([{ address: OWNER, data: new Uint8Array([7, 8]), lamports: 0n }]);
    expect(s.calls).toEqual([`program-accounts:${INTENT_ENGINE_PROGRAM_ADDRESS}:${JSON.stringify({ encoding: "base64", commitment: "confirmed", filters: [], withContext: true })}`]);
    const rpc = {
      ...s.rpc,
      getProgramAccounts: () => ({
        send: async () => ({
          context: { slot: 3n },
          value: [{ pubkey: OTHER, account: { data: [Buffer.from([9]).toString("base64"), "base64"] as const, lamports: 11n } }],
        }),
      }),
    } satisfies RpcLike;
    expect(await rpcTransport(rpc, s.wait).engineAccounts?.()).toEqual([{ address: OTHER, data: new Uint8Array([9]), lamports: 11n }]);
  });
});

describe("engine transactions", () => {
  it("keeps only inner instructions the engine emitted, including through lookup tables, with the memos and the fee payer", async () => {
    const s = stub([]);
    const transport = rpcTransport(s.rpc, s.wait);
    const found = await transport.engineTransactions(5);
    expect(found).toEqual([
      { signature: SIG, slot: 7n, blockTime: 100n, failed: false, emitted: [new Uint8Array([1, 2]), new Uint8Array([4, 5])], emittedAccounts: [[], []], memos: ["delivery note"], memoSigners: [[OWNER]], feePayer: OWNER, called: [new TextEncoder().encode("not a memo")], calledAccounts: [[]] },
      { signature: OTHER_SIG, slot: 8n, blockTime: null, failed: true, emitted: [], unread: true },
    ]);
    expect(s.calls).toEqual([
      `signatures:${INTENT_ENGINE_PROGRAM_ADDRESS}:5`,
      `transaction:${SIG}:json:0:confirmed`,
      `transaction:${OTHER_SIG}:json:0:confirmed`,
    ]);
    s.calls.length = 0;
    expect(await transport.engineTransactions(5)).toEqual(found);
    expect(s.calls).toEqual([`signatures:${INTENT_ENGINE_PROGRAM_ADDRESS}:5`, `transaction:${OTHER_SIG}:json:0:confirmed`]);
  });

  it("fetches only the transactions whose listed memo contains the asked text", async () => {
    const s = stub([]);
    const asked: string[] = [];
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: SIG, slot: 7n, blockTime: 100n, err: null, memo: "[52] solive-delivery:x" },
          { signature: OTHER_SIG, slot: 8n, blockTime: 1n, err: null, memo: null },
        ],
      }),
      getTransaction: (signature: Signature) => ({
        send: async () => {
          asked.push(signature);
          return null;
        },
      }),
    };
    const found = await rpcTransport(rpc, s.wait).engineTransactions(5, OWNER, "solive-delivery:");
    expect(found.map(({ signature }) => signature)).toEqual([SIG]);
    expect(asked).toEqual([SIG]);
  });

  it("lists a page of signatures before a given one with their memos, and fetches only the listed transactions it is handed", async () => {
    const s = stub([]);
    const configs: unknown[] = [];
    const asked: string[] = [];
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: (_: Address, config: unknown) => {
        configs.push(config);
        return { send: async () => [{ signature: SIG, slot: 7n, blockTime: 100n, err: { InstructionError: [0, "Custom"] }, memo: "[3] abc" }, { signature: OTHER_SIG, slot: 6n, blockTime: null, err: null }] };
      },
      getTransaction: (signature: Signature) => ({
        send: async () => {
          asked.push(signature);
          return { transaction: { message: { accountKeys: [] } }, meta: {} };
        },
      }),
    };
    const transport = rpcTransport(rpc as unknown as typeof s.rpc, s.wait);
    const listed = (await transport.signaturesOf?.(OWNER, 1000, OTHER_SIG)) ?? [];
    expect(configs).toEqual([{ limit: 1000, before: OTHER_SIG }]);
    expect(listed).toEqual([
      { signature: SIG, slot: 7n, blockTime: 100n, failed: true, memo: "[3] abc" },
      { signature: OTHER_SIG, slot: 6n, blockTime: null, failed: false, memo: null },
    ]);
    expect((await transport.signaturesOf?.(OWNER, 5)) ?? []).toHaveLength(2);
    expect(configs[1]).toEqual({ limit: 5 });
    const found = (await transport.transactionsOf?.(listed.slice(1))) ?? [];
    expect(found).toEqual([{ signature: OTHER_SIG, slot: 6n, blockTime: null, failed: false, emitted: [] }]);
    expect(asked).toEqual([OTHER_SIG]);
  });

  it("reads the node's first available slot only from a node that answers it", async () => {
    const s = stub([]);
    const transport = rpcTransport({ ...s.rpc, getFirstAvailableBlock: () => ({ send: async () => 42n }) } as unknown as typeof s.rpc, s.wait);
    expect(await transport.firstAvailableSlot?.()).toBe(42n);
    expect(rpcTransport(s.rpc, s.wait).firstAvailableSlot).toBeUndefined();
  });

  it("keeps a bounded number of fetched transactions and fetches only the ones it dropped", async () => {
    const s = stub([]);
    const sigs = Array.from({ length: KEPT_TRANSACTIONS + 1 }, (_, i) => `${SIG.slice(0, -4)}${String(i).padStart(4, "0")}` as Signature);
    const asked: string[] = [];
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: (_: Address, config: { limit: number }) => ({
        send: async () => sigs.slice(0, config.limit).map((signature, i) => ({ signature, slot: BigInt(i), blockTime: 1n, err: null })),
      }),
      getTransaction: (signature: Signature) => ({
        send: async () => {
          asked.push(signature);
          return { transaction: { message: { accountKeys: [] } }, meta: {} };
        },
      }),
    };
    const transport = rpcTransport(rpc as unknown as typeof s.rpc, s.wait);
    await transport.engineTransactions(sigs.length);
    asked.length = 0;
    await transport.engineTransactions(10);
    expect(asked).toEqual([sigs[0]]);
  });

  it("shares a fetch already under way instead of asking the node twice", async () => {
    const s = stub([]);
    const transport = rpcTransport(s.rpc, s.wait);
    const [first, second] = await Promise.all([transport.engineTransactions(5), transport.engineTransactions(5)]);
    expect(second).toEqual(first);
    expect(s.calls.filter((c) => c.startsWith("transaction:"))).toEqual([
      `transaction:${SIG}:json:0:confirmed`,
      `transaction:${OTHER_SIG}:json:0:confirmed`,
    ]);
  });

  it("fetches again a transaction the node returned without its metadata or block time", async () => {
    const s = stub([]);
    let calls = 0;
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: SIG, slot: 1n, blockTime: 100n, err: null },
          { signature: OTHER_SIG, slot: 2n, blockTime: null, err: null },
        ],
      }),
      getTransaction: () => ({
        send: async () => {
          calls++;
          return calls === 1 ? { transaction: { message: { accountKeys: [] } }, meta: null } : { transaction: { message: { accountKeys: [] } }, meta: {} };
        },
      }),
    };
    const transport = rpcTransport(rpc as unknown as typeof s.rpc, s.wait);
    await transport.engineTransactions(2);
    await transport.engineTransactions(2);
    await transport.engineTransactions(2);
    expect(calls).toBe(5);
  });

  it("reads one address's transactions when asked, fetching a few at a time and keeping their order", async () => {
    const s = stub([]);
    const sigs = Array.from({ length: TRANSACTION_FETCHES * 2 + 1 }, (_, i) => `${SIG.slice(0, -2)}${String(i).padStart(2, "1")}` as Signature);
    let open = 0;
    let most = 0;
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: (address: Address, config: { limit: number }) => ({
        send: async () => {
          s.calls.push(`signatures:${address}:${config.limit}`);
          return sigs.map((signature, i) => ({ signature, slot: BigInt(i), blockTime: null, err: null }));
        },
      }),
      getTransaction: () => ({
        send: async () => {
          open++;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 1));
          open--;
          return null;
        },
      }),
    };
    const found = await rpcTransport(rpc as unknown as typeof s.rpc, s.wait).engineTransactions(9, OWNER);
    expect(found.map((tx) => tx.signature)).toEqual(sigs);
    expect(s.calls).toEqual([`signatures:${OWNER}:9`]);
    expect(most).toBe(TRANSACTION_FETCHES);
  });
});
