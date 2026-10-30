import { type Address, type Blockhash, getBase58Decoder, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type ListedSignature, type RpcLike, rpcTransport } from "../src/internal.js";
import { isolateMocks, OWNER, OTHER, SIG, signedWire, stub } from "./transport-stub.js";

isolateMocks();

const SYSTEM = "11111111111111111111111111111111" as Address;
const LATEST = { blockhash: "" as Blockhash, lastValidBlockHeight: 10n };
const LISTED: ListedSignature = { signature: SIG, slot: 1n, blockTime: 5n, failed: false, memo: null };

const confirmedAt = (slot: bigint) => ({
  send: async () => ({ context: { slot: 1_000_000n }, value: [{ err: null, confirmationStatus: "confirmed", slot }] }),
});

function sending(extra: Partial<RpcLike> = {}) {
  const s = stub([]);
  const configs: Record<string, unknown>[] = [];
  const rpc = {
    ...s.rpc,
    sendTransaction: (wire: string, config: Record<string, unknown>) => ({
      send: async () => {
        configs.push(config);
        return s.rpc.sendTransaction(wire, config as { encoding: string }).send();
      },
    }),
    getSignatureStatuses: () => confirmedAt(10n),
    ...extra,
  } as RpcLike;
  return { ...s, rpc, configs };
}

const transaction = (signature: Signature, meta: Record<string, unknown> | null, instructions: unknown[] = [], keys: Address[] = [OWNER, SYSTEM, OTHER]) => ({
  transaction: { signatures: [signature], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions } },
  meta,
  slot: 3n,
  blockTime: 9n,
});

const transfer = (lamports: bigint) => {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return getBase58Decoder().decode(data);
};

describe("what a send asks of the node", () => {
  it("runs the preflight checks of a normal send", async () => {
    const r = sending();
    await rpcTransport(r.rpc, r.wait).sendWire(await signedWire(), LATEST);
    expect(r.configs).toStrictEqual([{ encoding: "base64" }]);
  });

  it("skips the preflight checks of a raw submit", async () => {
    const r = sending();
    await rpcTransport(r.rpc, r.wait).submitWire(await signedWire());
    expect(r.configs).toStrictEqual([{ encoding: "base64", skipPreflight: true }]);
  });
});

describe("reading at least the slot already reached", () => {
  const programSlots = () => {
    const slots: (bigint | undefined)[] = [];
    const rpc = sending({
      getProgramAccounts: (_program: Address, config: { minContextSlot?: bigint }) => ({
        send: async () => {
          slots.push(config.minContextSlot);
          return [];
        },
      }),
    } as Partial<RpcLike>);
    return { slots, rpc };
  };

  it("keeps a slot read from the caller when it is ahead of the reached slot", async () => {
    const { slots, rpc } = programSlots();
    const t = rpcTransport(rpc.rpc, rpc.wait);
    await t.sendWire(await signedWire(), LATEST);
    await t.intents({}, { minContextSlot: 50n });
    expect(slots).toStrictEqual([50n]);
  });

  it("keeps the reached slot when the caller is behind it", async () => {
    const { slots, rpc } = programSlots();
    const t = rpcTransport(rpc.rpc, rpc.wait);
    await t.sendWire(await signedWire(), LATEST);
    await t.intents({}, { minContextSlot: 4n });
    expect(slots).toStrictEqual([10n]);
  });

  it("reads at the slot of the caller when nothing is reached yet", async () => {
    const { slots, rpc } = programSlots();
    await rpcTransport(rpc.rpc, rpc.wait).intents({}, { minContextSlot: 4n });
    expect(slots).toStrictEqual([4n]);
  });
});

describe("account reads in chunks", () => {
  it("makes no request for no addresses", async () => {
    const r = stub([]);
    expect(await rpcTransport(r.rpc, r.wait).getAccounts([])).toStrictEqual([]);
    expect(r.calls).toStrictEqual([]);
  });
});

describe("a single transaction read", () => {
  const reading = (meta: Record<string, unknown> | null, instructions: unknown[] = []) =>
    rpcTransport(
      { ...stub([]).rpc, getTransaction: (signature: Signature) => ({ send: async () => transaction(signature, meta, instructions) }) } as RpcLike,
      stub([]).wait,
    );

  it("marks a transaction with an error in its meta as failed", async () => {
    const found = await reading({ err: { InstructionError: [0, "InvalidArgument"] } }).transactionOf?.(SIG);
    expect(found).toMatchObject({ signature: SIG, failed: true });
  });

  it("does not mark a transaction with no error, or an unset error, as failed", async () => {
    expect(await reading({ err: null }).transactionOf?.(SIG)).toMatchObject({ failed: false });
    expect(await reading({}).transactionOf?.(SIG)).toMatchObject({ failed: false });
  });

  it("reads a system transfer between the accounts it names", async () => {
    const found = await reading({ err: null }, [{ programIdIndex: 1, accounts: [0, 2], data: transfer(5n) }]).transactionOf?.(SIG);
    expect(found?.transfers).toStrictEqual([{ from: OWNER, to: OTHER, lamports: 5n }]);
  });
});

describe("transactions read in a batch", () => {
  it("reads a transaction again after its first read failed", async () => {
    let reads = 0;
    const s = stub([]);
    const rpc = {
      ...s.rpc,
      getTransaction: (signature: Signature) => ({
        send: async () => {
          reads += 1;
          if (reads === 1) {
            throw new Error("node hiccup");
          }
          return transaction(signature, { err: null });
        },
      }),
    } as RpcLike;
    const t = rpcTransport(rpc, s.wait);
    const batch = t.transactionsOf as NonNullable<typeof t.transactionsOf>;
    await expect(batch([LISTED])).rejects.toThrow("node hiccup");
    expect(await batch([LISTED])).toMatchObject([{ signature: SIG }]);
    expect(reads).toBe(2);
  });
});
