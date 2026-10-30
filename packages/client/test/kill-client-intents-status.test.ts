import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { signatureStatus } from "../src/confirmation.js";
import { explain } from "../src/errors.js";
import { earliestFunder, FUNDING_READS } from "../src/funding.js";
import type { RpcLike } from "../src/internal.js";
import { FailedOnChain } from "../src/send-errors.js";
import { testSignature } from "../src/testing.js";
import type { EngineTransaction, ListedSignature, Transport } from "../src/transport.js";

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const SIG = testSignature("the status");
const NO_WAIT = async () => undefined;

function statusRpc(answer: unknown, epoch: { blockHeight: bigint; absoluteSlot: bigint } | null, tx: unknown = null) {
  const configs: unknown[] = [];
  const rpc = {
    getEpochInfo: () => ({ send: async () => epoch }),
    getSignatureStatuses: (_signatures: Signature[], config: unknown) => ({
      send: async () => {
        configs.push(config);
        return { context: { slot: 10n }, value: [answer] };
      },
    }),
    getTransaction: () => ({ send: async () => tx }),
  } as unknown as RpcLike;
  return { rpc, configs };
}

describe("a signature's status", () => {
  const epoch = { blockHeight: 100n, absoluteSlot: 10n };

  it("searches the node's history for the signature", async () => {
    const { rpc, configs } = statusRpc(null, epoch);
    await signatureStatus(rpc, SIG, 100n, NO_WAIT);
    expect(configs).toStrictEqual([{ searchTransactionHistory: true }]);
  });

  it("counts a confirmed or finalized answer as confirmed and a processed one as pending", async () => {
    for (const confirmationStatus of ["confirmed", "finalized"]) {
      const { rpc } = statusRpc({ err: null, confirmationStatus, slot: 9n }, epoch);
      expect(await signatureStatus(rpc, SIG, 100n, NO_WAIT)).toStrictEqual({ status: "confirmed", signature: SIG, slot: 9n });
    }
    const processed = statusRpc({ err: null, confirmationStatus: "processed", slot: 9n }, epoch);
    expect(await signatureStatus(processed.rpc, SIG, 100n, NO_WAIT)).toStrictEqual({ status: "pending", signature: SIG });
  });

  it("reads the logs and the failing program of a transaction that failed", async () => {
    const tx = { transaction: { message: { accountKeys: [INTENT_ENGINE_PROGRAM_ADDRESS], instructions: [{ programIdIndex: 0 }] } }, meta: { logMessages: ["Program log: first", "Program log: second"] } };
    const err = { InstructionError: [0, { Custom: 6003 }] };
    const { rpc } = statusRpc({ err, confirmationStatus: "confirmed", slot: 9n }, epoch, tx);
    const found = await signatureStatus(rpc, SIG, 100n, NO_WAIT);
    expect(found).toMatchObject({ status: "failed", signature: SIG, err, program: INTENT_ENGINE_PROGRAM_ADDRESS, logs: ["Program log: first", "Program log: second"] });
    const bare = statusRpc({ err, confirmationStatus: "confirmed", slot: 9n }, epoch, { ...tx, meta: {} });
    expect("logs" in (await signatureStatus(bare.rpc, SIG, 100n, NO_WAIT))).toBe(false);
  });

  it("calls a missing signature expired only once the chain is past its last valid block height", async () => {
    const at = async (lastValid: bigint) => (await signatureStatus(statusRpc(null, epoch).rpc, SIG, lastValid, NO_WAIT)).status;
    expect(await at(101n)).toBe("pending");
    expect(await at(100n)).toBe("pending");
    expect(await at(99n)).toBe("expired");
    expect((await signatureStatus(statusRpc(null, { blockHeight: 100n, absoluteSlot: 11n }).rpc, SIG, 99n, NO_WAIT)).status).toBe("pending");
  });
});

describe("explaining an error", () => {
  const leaf = { context: { code: 6003 } };
  const nested = (depth: number, inner: object): object => (depth === 0 ? inner : { cause: nested(depth - 1, inner) });

  it("follows causes down to the eighth and no further, and survives a cause that loops", () => {
    expect(explain(nested(8, leaf))?.code).toBe(6003);
    expect(explain(nested(9, leaf))).toBeNull();
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(explain(loop)).toBeNull();
  });

  it("trusts the engine error a failed transaction carries when it names a program, and reads the message when it does not", () => {
    const engine = { code: 6003, name: "NonCanonical", message: "non canonical" };
    const named = new FailedOnChain("transaction failed", { signature: SIG, err: "boom", program: INTENT_ENGINE_PROGRAM_ADDRESS, engine });
    expect(explain(named)).toStrictEqual(engine);
    const bare = new FailedOnChain("transaction failed, custom program error: 0x1773", { signature: SIG, err: "boom", program: INTENT_ENGINE_PROGRAM_ADDRESS });
    expect(explain(bare)).toBeNull();
    const unnamed = new FailedOnChain("transaction failed, custom program error: 0x1773", { signature: SIG, err: "boom", program: null });
    expect(explain(unnamed)).toStrictEqual(engine);
    const unnamedWithEngine = new FailedOnChain("transaction failed", { signature: SIG, err: "boom", program: null, engine });
    expect(explain(unnamedWithEngine)).toBeNull();
  });
});

describe("the wallet that first funded another", () => {
  const WALLET = key(40);
  const FUNDER = key(41);
  const listedAt = (i: number): ListedSignature => ({ signature: testSignature(`funding ${i}`), slot: BigInt(i), blockTime: null, failed: false, memo: null });
  const covered = async () => true;

  function chainOf(newestFirst: ListedSignature[], fundedAt: string | null, fetch?: (batch: ListedSignature[]) => EngineTransaction[]) {
    const befores: (string | undefined)[] = [];
    const fetched: string[][] = [];
    const transport = {
      signaturesOf: async (_of: Address, limit: number, before?: string) => {
        befores.push(before);
        const from = before === undefined ? 0 : newestFirst.findIndex((entry) => entry.signature === before) + 1;
        return newestFirst.slice(from, from + limit);
      },
      transactionsOf: async (batch: ListedSignature[]) => {
        fetched.push(batch.map(({ signature }) => signature));
        if (fetch !== undefined) {
          return fetch(batch);
        }
        return batch.map(({ signature }): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [], transfers: signature === fundedAt ? [{ from: FUNDER, to: WALLET, lamports: 5n }] : [] }));
      },
    } as unknown as Transport;
    return { transport, befores, fetched };
  }

  it("pages back from the last signature of the page before", async () => {
    const all = Array.from({ length: 1_500 }, (_, i) => listedAt(1_500 - i));
    const oldest = all[all.length - 1] as ListedSignature;
    const { transport, befores } = chainOf(all, oldest.signature);
    expect(await earliestFunder(transport, WALLET, covered)).toStrictEqual({ funder: FUNDER, complete: true });
    expect(befores).toStrictEqual([undefined, (all[999] as ListedSignature).signature, oldest.signature]);
  });

  it("stops reading after the read limit and says it did not finish", async () => {
    const all = Array.from({ length: FUNDING_READS + 4 }, (_, i) => listedAt(FUNDING_READS + 4 - i));
    const oldestFirst = [...all].reverse();
    const late = chainOf(all, (oldestFirst[FUNDING_READS + 1] as ListedSignature).signature);
    expect(await earliestFunder(late.transport, WALLET, covered)).toStrictEqual({ funder: null, complete: false });
    expect(late.fetched.flat()).toStrictEqual(oldestFirst.slice(0, FUNDING_READS).map(({ signature }) => signature));
    const inTime = chainOf(all, (oldestFirst[FUNDING_READS - 1] as ListedSignature).signature);
    expect(await earliestFunder(inTime.transport, WALLET, covered)).toStrictEqual({ funder: FUNDER, complete: true });
  });

  it("finishes, funderless and complete, when every listed transaction was read and none funded the wallet", async () => {
    const all = Array.from({ length: 6 }, (_, i) => listedAt(6 - i));
    const chain = chainOf(all, null);
    const reads = chain.transport.transactionsOf as NonNullable<Transport["transactionsOf"]>;
    let calls = 0;
    (chain.transport as { transactionsOf: unknown }).transactionsOf = async (batch: ListedSignature[]) => {
      calls++;
      if (calls > 20) {
        throw new Error("read past the end of the history");
      }
      return reads.call(chain.transport, batch);
    };
    expect(await earliestFunder(chain.transport, WALLET, covered)).toStrictEqual({ funder: null, complete: true });
    expect(calls).toBe(2);
    expect(await earliestFunder(chain.transport, WALLET, async () => false)).toStrictEqual({ funder: null, complete: false });
  }, 2_000);

  it("gives up when the node returns fewer transactions than it was asked for", async () => {
    const all = Array.from({ length: 4 }, (_, i) => listedAt(4 - i));
    const oldest = all[all.length - 1] as ListedSignature;
    const short = chainOf(all, oldest.signature, (batch) => batch.slice(0, 2).map(({ signature }): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [], transfers: [{ from: FUNDER, to: WALLET, lamports: 5n }] })));
    expect(await earliestFunder(short.transport, WALLET, covered)).toStrictEqual({ funder: null, complete: false });
  });

  it("gives up at a transaction it could not read", async () => {
    const all = Array.from({ length: 4 }, (_, i) => listedAt(4 - i));
    const unread = chainOf(all, null, (batch) => batch.map(({ signature }): EngineTransaction => ({ signature, slot: 1n, blockTime: null, failed: false, emitted: [], unread: true })));
    expect(await earliestFunder(unread.transport, WALLET, covered)).toStrictEqual({ funder: null, complete: false });
  });
});
