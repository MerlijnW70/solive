import { type Address, createSolanaRpcFromTransport, getAddressDecoder, getBase58Decoder, type RpcTransport, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeEvent, EVENT_IX_TAG, INTENT_ENGINE_PROGRAM_ADDRESS, type JsonTransaction, transactionEvents } from "../src/index.js";
import { getJobClaimedEventEncoder, getUserInitializedEventEncoder } from "../src/internal.js";

const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

const JOB = addressOf(1);
const WORKER = addressOf(2);
const OTHER_PROGRAM = addressOf(3);
const claimed = (stake: bigint) => tagged(getJobClaimedEventEncoder().encode({ intent: JOB, worker: WORKER, until: 9n, stake }));
const testSignature = getBase58Decoder().decode(new Uint8Array(64).fill(9)) as Signature;
const user = tagged(getUserInitializedEventEncoder().encode({ owner: WORKER }));

function json(groups: { index: number; calls: { program: number; data: Uint8Array | string }[] }[], loaded = false): JsonTransaction {
  const keys = loaded ? [WORKER, OTHER_PROGRAM] : [WORKER, OTHER_PROGRAM, INTENT_ENGINE_PROGRAM_ADDRESS];
  return {
    transaction: { message: { accountKeys: keys } },
    meta: {
      innerInstructions: groups.map(({ index, calls }) => ({
        index,
        instructions: calls.map(({ program, data }) => ({ programIdIndex: program, data: typeof data === "string" ? data : b58(data) })),
      })),
      loadedAddresses: { writable: [], readonly: loaded ? [INTENT_ENGINE_PROGRAM_ADDRESS] : [] },
    },
  };
}

describe("the events of a transaction", () => {
  it("decodes every program event from inner instructions, with no log lines, each with its instruction position", () => {
    const events = transactionEvents(
      json([
        { index: 0, calls: [{ program: 1, data: claimed(1n) }, { program: 2, data: claimed(5n) }] },
        { index: 2, calls: [{ program: 2, data: user }, { program: 2, data: claimed(7n) }] },
      ]),
    );
    expect(events.map(({ name, instruction, inner }) => [name, instruction, inner])).toEqual([
      ["JobClaimed", 0, 1],
      ["UserInitialized", 2, 0],
      ["JobClaimed", 2, 1],
    ]);
    const [first] = events;
    expect(first?.name === "JobClaimed" ? first.fields : null).toMatchObject({ intent: JOB, worker: WORKER, stake: 5n, until: 9n });
  });

  it("returns nothing for a transaction that failed, whatever its inner instructions hold", () => {
    const landed = json([{ index: 0, calls: [{ program: 2, data: user }] }]);
    expect(transactionEvents({ ...landed, meta: { ...landed.meta, err: null } })).toHaveLength(1);
    expect(transactionEvents({ ...landed, meta: { ...landed.meta, err: { InstructionError: [0, "Custom"] } } })).toEqual([]);
  });

  it("finds the program among loaded addresses", () => {
    expect(transactionEvents(json([{ index: 1, calls: [{ program: 2, data: user }] }], true)).map(({ name, instruction }) => [name, instruction])).toEqual([
      ["UserInitialized", 1],
    ]);
  });

  it("skips calls of other programs, untagged data and data that is not base58", () => {
    const untagged = getUserInitializedEventEncoder().encode({ owner: WORKER });
    const events = transactionEvents(
      json([{ index: 0, calls: [{ program: 1, data: user }, { program: 2, data: Uint8Array.from(untagged) }, { program: 2, data: "0OIl" }, { program: 2, data: user }] }]),
    );
    expect(events.map(({ inner }) => inner)).toEqual([3]);
  });

  it("returns nothing for a missing transaction, missing meta or no inner instructions", () => {
    expect(transactionEvents(null)).toEqual([]);
    expect(transactionEvents(undefined)).toEqual([]);
    expect(transactionEvents({ transaction: { message: { accountKeys: [INTENT_ENGINE_PROGRAM_ADDRESS] } }, meta: null })).toEqual([]);
    expect(transactionEvents({ transaction: { message: { accountKeys: [INTENT_ENGINE_PROGRAM_ADDRESS] } }, meta: { innerInstructions: null } })).toEqual([]);
  });

  it("takes the answer of a kit getTransaction in json encoding as it is", async () => {
    const answer = { slot: 5, blockTime: 9, version: 0, ...json([{ index: 1, calls: [{ program: 2, data: claimed(4n) }] }]) };
    const node = (async ({ payload }: { payload: unknown }) => ({ jsonrpc: "2.0", id: (payload as { id: unknown }).id, result: answer })) as RpcTransport;
    const rpc = createSolanaRpcFromTransport(node);
    const read = await rpc.getTransaction(testSignature, { encoding: "json", maxSupportedTransactionVersion: 0 }).send();
    expect(transactionEvents(read).map(({ name, instruction, inner }) => [name, instruction, inner])).toEqual([["JobClaimed", 1, 0]]);
  });

  it("exports the typed decoder from the package root", () => {
    const event = decodeEvent(claimed(3n));
    expect(event?.name).toBe("JobClaimed");
    expect(event?.name === "JobClaimed" ? event.fields.stake : null).toBe(3n);
    expect(decodeEvent(new Uint8Array(4))).toBeNull();
  });
});
