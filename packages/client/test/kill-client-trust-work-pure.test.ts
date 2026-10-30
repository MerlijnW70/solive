import { type Address, generateKeyPairSigner, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM } from "@intent-engine/core";
import { feedbackMemo } from "@intent-engine/core/internal";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/accounts.js";
import { type EngineTransaction, type ListedSignature, type Transport } from "../src/index.js";
import { ownHistory } from "../src/internal.js";
import { errOf } from "../src/svm-errors.js";
import { testSignature } from "../src/testing.js";
import { type CalledInstruction, solTransfersOf } from "../src/transaction-keys.js";
import { feedbackOf } from "../src/work-feedback.js";
import { comparatorsUsedBy, verdicts } from "./kill-client-trust-work-sort.js";

const address = async (): Promise<Address> => (await generateKeyPairSigner()).address;

const u32 = (value: number): number[] => Array.from(new Uint8Array(new Uint32Array([value]).buffer));

const u64 = (value: bigint): number[] => Array.from(new Uint8Array(new BigUint64Array([value]).buffer));

const systemTransfer = (lamports: bigint): CalledInstruction => ({ program: SYSTEM_PROGRAM_ADDRESS, accounts: [0, 1], data: Uint8Array.from([...u32(2), ...u64(lamports)]) });

const tokenCall = (kind: number[]): CalledInstruction => ({ program: TOKEN_PROGRAM, accounts: [1, 2, 3], data: Uint8Array.from(kind) });

describe("solTransfersOf", () => {
  it("reads the amount of a system transfer only when all eight bytes are there", async () => {
    const [payer, other] = await Promise.all([address(), address()]);
    const keys = [payer, other];
    expect(solTransfersOf(keys, [systemTransfer(5n)])).toEqual([{ from: payer, to: other, lamports: 5n }]);
    const cut: CalledInstruction = { program: SYSTEM_PROGRAM_ADDRESS, accounts: [0, 1], data: Uint8Array.from([...u32(2), 1, 2, 3, 4]) };
    expect(solTransfersOf(keys, [cut])).toEqual([]);
    const exact: CalledInstruction = { program: SYSTEM_PROGRAM_ADDRESS, accounts: [0, 1], data: Uint8Array.from([...u32(2), ...u64(7n)]) };
    expect(solTransfersOf(keys, [exact])).toEqual([{ from: payer, to: other, lamports: 7n }]);
  });

  it("reads a token close and a token excess withdrawal as the lamports their source account lost, from the owner to the destination", async () => {
    const [payer, source, destination, owner] = await Promise.all([address(), address(), address(), address()]);
    const keys = [payer, source, destination, owner];
    const balances = { before: [1_000n, 100n, 0n, 0n], after: [1_000n, 40n, 60n, 0n] };
    for (const kind of [9, 38]) {
      expect(solTransfersOf(keys, [tokenCall([kind])], balances)).toEqual([{ from: owner, to: destination, lamports: 60n }]);
    }
    expect(solTransfersOf(keys, [tokenCall([9])])).toEqual([]);
    expect(solTransfersOf(keys, [tokenCall([38])])).toEqual([]);
  });

  it("reads no token move from any other token instruction or an empty one, and credits the rise to the payer instead", async () => {
    const [payer, source, destination, owner] = await Promise.all([address(), address(), address(), address()]);
    const keys = [payer, source, destination, owner];
    const balances = { before: [1_000n, 100n, 0n, 0n], after: [1_000n, 40n, 60n, 0n] };
    for (const data of [[3], [], [8], [37], [39]]) {
      expect(solTransfersOf(keys, [tokenCall(data)], balances)).toEqual([{ from: payer, to: destination, lamports: 60n }]);
    }
  });

  it("credits the payer with a balance rise nothing else explains, and with none that did not rise", async () => {
    const [payer, riser, still] = await Promise.all([address(), address(), address()]);
    const keys = [payer, riser, still];
    expect(solTransfersOf(keys, [], { before: [10n, 5n, 3n], after: [10n, 9n, 3n] })).toStrictEqual([{ from: payer, to: riser, lamports: 4n }]);
    expect(solTransfersOf(keys, [], { before: [10n, 5n, 3n], after: [10n, 5n, 3n] })).toStrictEqual([]);
    expect(solTransfersOf(keys, [], { before: [10n, 5n, 3n], after: [10n, 5n, 2n] })).toStrictEqual([]);
  });

  it("still credits the payer with a rise when the only transfer decoded to that account moved nothing", async () => {
    const [payer, other] = await Promise.all([address(), address()]);
    expect(solTransfersOf([payer, other], [systemTransfer(0n)], { before: [10n, 5n], after: [10n, 9n] })).toStrictEqual([
      { from: payer, to: other, lamports: 0n },
      { from: payer, to: other, lamports: 4n },
    ]);
    expect(solTransfersOf([payer, other], [systemTransfer(2n)], { before: [10n, 5n], after: [10n, 9n] })).toStrictEqual([{ from: payer, to: other, lamports: 2n }]);
  });
});

describe("errOf", () => {
  const failing = (err: unknown) => ({ err: () => err }) as never;

  it("reads a program error with a numeric index and an error function as an instruction error", () => {
    expect(errOf(failing({ index: 2, err: () => ({ code: 7 }) }))).toEqual({ InstructionError: [2, { Custom: 7 }] });
    expect(errOf(failing({ index: 0, err: () => "plain" }))).toEqual({ InstructionError: [0, "plain"] });
  });

  it("falls back to the error's text when either the index or the error function is missing", () => {
    expect(errOf(failing({ index: 1 }))).toBe("[object Object]");
    expect(errOf(failing({ index: "1", err: () => ({ code: 7 }) }))).toBe("[object Object]");
    expect(errOf(failing({ err: () => ({ code: 7 }) }))).toBe("[object Object]");
    expect(errOf(failing({ index: 1, err: "no" }))).toBe("[object Object]");
  });
});

const landed = (slot: bigint, extra: Partial<EngineTransaction> = {}): EngineTransaction => ({ signature: testSignature(`feedback-${slot}-${extra.memos?.join("") ?? ""}`), slot, blockTime: null, failed: false, emitted: [], ...extra });

describe("feedbackOf", () => {
  it("takes the earliest feedback from the owner, wherever it sits in the list, and the first of two in one slot", async () => {
    const [intent, owner] = await Promise.all([address(), address()]);
    const memo = (score: number) => feedbackMemo({ intent, score });
    const late = landed(9n, { memos: [memo(10)], memoSigners: [[owner]] });
    const early = landed(3n, { memos: [memo(70)], memoSigners: [[owner]] });
    const middle = landed(5n, { memos: [memo(40)], memoSigners: [[owner]] });
    expect(feedbackOf([late, early, middle], intent, owner)).toBe(70);
    expect(feedbackOf([early, middle, late], intent, owner)).toBe(70);
    const first = landed(4n, { memos: [memo(11)], memoSigners: [[owner]] });
    const second = landed(4n, { memos: [memo(22)], memoSigners: [[owner]] });
    expect(feedbackOf([first, second], intent, owner)).toBe(11);
    expect(feedbackOf([second, first], intent, owner)).toBe(22);
  });

  it("orders by slot with a comparator that says less, greater and equal", async () => {
    const [intent, owner] = await Promise.all([address(), address()]);
    const memo = feedbackMemo({ intent, score: 5 });
    const pair = [landed(2n, { memos: [memo], memoSigners: [[owner]] }), landed(1n, { memos: [memo], memoSigners: [[owner]] })];
    const compare = (await comparatorsUsedBy(() => feedbackOf(pair, intent, owner), "slot"))[0];
    expect(verdicts(compare, (slot) => landed(slot))).toEqual([-1, 1, 0]);
  });
});

describe("ownHistory limits", () => {
  const landedAt = (n: number): EngineTransaction => ({ signature: testSignature(`own-${n}`), slot: 1n, blockTime: null, failed: false, emitted: [] });

  it("is complete only when the node returned fewer transactions than were asked for", async () => {
    const wallet = await address();
    const stub = (count: number) => ({ engineTransactions: async () => Array.from({ length: count }, (_, n) => landedAt(n)) }) as unknown as Transport;
    expect(await ownHistory(stub(3), wallet, 3)).toMatchObject({ complete: false });
    expect((await ownHistory(stub(3), wallet, 3)).transactions).toHaveLength(3);
    expect(await ownHistory(stub(3), wallet, 4)).toMatchObject({ complete: true });
    expect(await ownHistory(stub(5), wallet, 3)).toMatchObject({ complete: false });
  });

  it("asks the node for no transactions when every listed signature failed, and for exactly one batch when four succeeded", async () => {
    const wallet = await address();
    const listed = (count: number, failed: boolean): ListedSignature[] => Array.from({ length: count }, (_, n) => ({ signature: testSignature(`listed-${n}-${failed}`), slot: 1n, blockTime: null, failed, memo: null }));
    const run = async (signatures: ListedSignature[]) => {
      const batches: number[] = [];
      const transport = {
        signaturesOf: async (_of: Address, _limit: number, before?: string) => (before === undefined ? signatures : []),
        transactionsOf: async (batch: ListedSignature[]) => {
          batches.push(batch.length);
          return batch.map(({ signature }) => ({ signature: signature as Signature, slot: 1n, blockTime: null, failed: false, emitted: [] }));
        },
      } as unknown as Transport;
      const history = await ownHistory(transport, wallet, signatures.length);
      return { batches, history };
    };
    expect((await run(listed(3, true))).batches).toEqual([]);
    const four = await run(listed(4, false));
    expect(four.batches).toEqual([4]);
    expect(four.history.transactions).toHaveLength(4);
    expect((await run(listed(5, false))).batches).toEqual([4, 1]);
    expect((await run(listed(8, false))).batches).toEqual([4, 4]);
  });
});
