import { type Address, type Instruction, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST, NATIVE_MINT as WSOL, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { COMPUTE_BUDGET_ADDRESS, decodeEvent, getIntentDecoder, getIntentEncoder, INTENT_ENGINE_PROGRAM_ADDRESS, U64_MAX } from "@intent-engine/core/internal";
import { connect, InvalidInput, type SimpleClient } from "../src/index.js";
import { type EngineTransaction, failure, MEMO_PROGRAM_ADDRESS, type Transport } from "../src/transport.js";
import { wrapIfShort } from "../src/setup.js";
import { amountShown, secondsOf, specHashBytes } from "../src/simple-tokens.js";
import { shown } from "../src/shown.js";
import { testSignature } from "../src/testing.js";
import { funded, world, type World } from "./svm.js";
import { keyed, sha, workUrl } from "./work.js";

const WORK = sha("the kill simple work");
const SPEC = sha("the kill simple spec");
const NOT_TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

function preset(w: World, at: Address): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function devnet() {
  const w = await world();
  preset(w, WSOL);
  preset(w, TEST);
  const at = (signer: KeyPairSigner, transport: Transport = w.chain.transport) => connect({ cluster: "devnet", signer, transport });
  return { w, at };
}

function filledAt(w: World, escrow: Address, filled: bigint): Transport {
  const edit = (address: Address, view: Awaited<ReturnType<Transport["getAccount"]>>) =>
    view !== null && address === escrow ? { ...view, data: new Uint8Array(getIntentEncoder().encode({ ...getIntentDecoder().decode(view.data), filled })) } : view;
  return {
    ...w.chain.transport,
    getAccount: async (address) => edit(address, await w.chain.transport.getAccount(address)),
    getAccounts: async (addresses) => (await w.chain.transport.getAccounts(addresses)).map((view, i) => edit(addresses[i] as Address, view)),
  };
}

function withoutDelivery(transport: Transport): Transport {
  const strip = (found: EngineTransaction[]) =>
    found.map((tx) => {
      const keep = tx.emitted.map((data) => decodeEvent(data)?.name !== "DeliveryReleased");
      return {
        ...tx,
        emitted: tx.emitted.filter((_, i) => keep[i]),
        ...(tx.emittedAccounts === undefined ? {} : { emittedAccounts: tx.emittedAccounts.filter((_, i) => keep[i]) }),
      };
    });
  const transactionsOf = transport.transactionsOf as NonNullable<Transport["transactionsOf"]>;
  return {
    ...transport,
    engineTransactions: async (limit, of, memo) => strip(await transport.engineTransactions(limit, of, memo)),
    transactionsOf: async (listed) => strip(await transactionsOf.call(transport, listed)),
  };
}

async function released(beforeRelease?: (w: World, at: (signer: KeyPairSigner) => Promise<SimpleClient<KeyPairSigner>>, escrow: Address) => Promise<void>) {
  const { w, at } = await devnet();
  const [owner, worker] = [await funded(w.chain), await funded(w.chain)];
  const judge = await keyed(w);
  const buyer = await at(owner);
  const reviewer = await at(judge.signer);
  const made = await buyer.payForWork({ amount: "0.01", judge: judge.signer.address, specHash: SPEC });
  const escrow = made.intent as Address;
  const seller = await at(worker);
  const announced = await seller.deliver({ escrow, sha256: WORK, url: workUrl() });
  await beforeRelease?.(w, at, escrow);
  return { w, at, owner, worker, judge, buyer, reviewer, seller, escrow, announcement: announced.announcement };
}

describe("how a value is shown", () => {
  it("cuts arrays at the ninth level", () => {
    let nested: unknown = [1];
    for (let i = 0; i < 8; i++) {
      nested = [nested];
    }
    expect(shown(nested)).toBe("[ ".repeat(8) + "[Array]" + " ]".repeat(8));
  });

  it("cuts objects at the ninth level", () => {
    let nested: unknown = { a: 1 };
    for (let i = 0; i < 8; i++) {
      nested = { a: nested };
    }
    expect(shown(nested)).toBe("{ a: ".repeat(8) + "[Object]" + " }".repeat(8));
  });

  it("shows eight levels of arrays and objects in full", () => {
    let nested: unknown = [{ a: [1] }];
    for (let i = 0; i < 2; i++) {
      nested = [nested];
    }
    expect(shown(nested)).toBe("[ [ [ { a: [ 1 ] } ] ] ]");
  });
});

describe("the amounts and times of the simple layer", () => {
  it("shows an amount from zero up to the largest u64 and refuses anything outside", () => {
    expect(amountShown(0n, 6)).toBe("0");
    expect(amountShown(U64_MAX, 0)).toBe(U64_MAX.toString());
    expect(() => amountShown(-1n, 6)).toThrow(InvalidInput);
    expect(() => amountShown(U64_MAX + 1n, 6)).toThrow(InvalidInput);
    expect(() => amountShown(5 as unknown as bigint, 6)).toThrow(InvalidInput);
  });

  it("takes seconds as a safe whole number or a bigint, and a fallback when none is given", () => {
    expect(secondsOf(60, 1n)).toBe(60n);
    expect(secondsOf(90n, 1n)).toBe(90n);
    expect(secondsOf(undefined, 7n)).toBe(7n);
    expect(() => secondsOf(1.5, 1n)).toThrow(InvalidInput);
    expect(() => secondsOf(Number.NaN, 1n)).toThrow(InvalidInput);
    expect(() => secondsOf(2 ** 60, 1n)).toThrow(InvalidInput);
  });

  it("takes a spec hash of exactly 32 bytes", () => {
    expect(specHashBytes(new Uint8Array(32).fill(5))).toStrictEqual(new Uint8Array(32).fill(5));
    expect(() => specHashBytes(new Uint8Array(31))).toThrow(InvalidInput);
    expect(() => specHashBytes(new Uint8Array(33))).toThrow(InvalidInput);
  });
});

describe("the program a failure is read from", () => {
  const sig = testSignature("kill failure");
  const programs = ["11111111111111111111111111111111" as Address, INTENT_ENGINE_PROGRAM_ADDRESS];

  it("reads an instruction index and custom code sent as numbers or as bigints", () => {
    const byNumber = failure(sig, { InstructionError: [1, { Custom: 6001 }] }, undefined, programs);
    const byBigint = failure(sig, { InstructionError: [1n, { Custom: 6001n }] }, undefined, programs);
    expect(byNumber.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(byNumber.engine).toMatchObject({ code: 6001, name: "DivideByZero" });
    expect({ ...byBigint, err: null }).toStrictEqual({ ...byNumber, err: null });
  });

  it("reads nothing from an index or code that is neither a safe number nor a bigint", () => {
    expect(failure(sig, { InstructionError: ["1", { Custom: 6001 }] }, undefined, programs).program).toBeNull();
    expect(failure(sig, { InstructionError: [1, { Custom: "6001" }] }, undefined, programs).engine).toBeUndefined();
    expect(failure(sig, { InstructionError: [1, { Custom: 2 ** 60 }] }, undefined, programs).engine).toBeUndefined();
  });
});

describe("wrapping sol to cover a shortfall", () => {
  it("wraps nothing for a token that is not wrapped sol under the token program", async () => {
    const { w } = await devnet();
    const owner = await funded(w.chain);
    expect(await wrapIfShort(w.chain.transport, owner, WSOL, NOT_TOKEN_PROGRAM, 10n)).toStrictEqual({ instructions: [], lamports: 0n });
    expect(await wrapIfShort(w.chain.transport, owner, TEST, TOKEN_PROGRAM_ADDRESS, 10n)).toStrictEqual({ instructions: [], lamports: 0n });
  });

  it("wraps the difference between what is held and what is needed", async () => {
    const { w, at } = await devnet();
    const owner = await funded(w.chain);
    const first = await wrapIfShort(w.chain.transport, owner, WSOL, TOKEN_PROGRAM_ADDRESS, 5_000n);
    expect(first.lamports).toBe(5_000n);
    await w.chain.transport.send(first.instructions, owner);
    expect(await wrapIfShort(w.chain.transport, owner, WSOL, TOKEN_PROGRAM_ADDRESS, 5_000n)).toStrictEqual({ instructions: [], lamports: 0n });
    expect(await wrapIfShort(w.chain.transport, owner, WSOL, TOKEN_PROGRAM_ADDRESS, 4_000n)).toStrictEqual({ instructions: [], lamports: 0n });
    const more = await wrapIfShort(w.chain.transport, owner, WSOL, TOKEN_PROGRAM_ADDRESS, 8_000n);
    expect(more.lamports).toBe(3_000n);
    expect(more.instructions).toHaveLength(2);
    const transfer = more.instructions[0]?.data as Uint8Array;
    expect(new DataView(transfer.buffer, transfer.byteOffset).getBigUint64(4, true)).toBe(3_000n);
    const solive = await at(owner);
    expect((await solive.balance(["SOL"])).summary).toMatch(/, 0\.000005 SOL wrapped$/);
  });
});

describe("the simple client over a transport it is given", () => {
  it("reads through that transport and not through the url", async () => {
    const { w } = await devnet();
    const owner = await funded(w.chain);
    const solive = await connect({ url: "http://127.0.0.1:9", signer: owner, transport: w.chain.transport });
    expect((await solive.balance(["SOL"])).sol).toBe("100");
  });
});

describe("the options given to connect", () => {
  it("sends with the priority fee asked for", async () => {
    const { w } = await devnet();
    const signer = await funded(w.chain);
    const seen: Instruction[][] = [];
    const recording: Transport = { ...w.chain.transport, send: (instructions, payer) => (seen.push([...instructions]), w.chain.transport.send(instructions, payer)) };
    const solive = await connect({ cluster: "devnet", signer, transport: recording, priority: 7n });
    await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5" });
    const price = seen.flat().find(({ programAddress, data }) => programAddress === COMPUTE_BUDGET_ADDRESS && data?.[0] === 3);
    expect(new DataView((price?.data as Uint8Array).buffer, (price?.data as Uint8Array).byteOffset).getBigUint64(1, true)).toBe(7n);
  });
});

describe("the orders of the simple client", () => {
  it("previews a swap with the intent and nonce it would create", async () => {
    const { w, at } = await devnet();
    const solive = await at(await funded(w.chain));
    const preview = await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5", preview: true });
    expect(Object.keys(preview).sort()).toStrictEqual(["instructions", "intent", "nonce", "summary"]);
    expect(preview.nonce).toBe(0n);
  });

  it("refuses a judge fee as large as the payment and accepts one below it", async () => {
    const { w, at } = await devnet();
    const solive = await at(await funded(w.chain));
    const judge = (await keyed(w)).signer.address;
    const pay = (judgeFee: string) => solive.payForWork({ amount: "1", judgeFee, judge, specHash: SPEC, preview: true });
    await expect(pay("1")).rejects.toMatchObject({ field: "judgeFee", rule: "range" });
    expect((await pay("0.9")).summary).toContain("judge fee 0.9 SOL");
  });

  it("puts the spec url in the escrow only when one is given", async () => {
    const { w, at } = await devnet();
    const solive = await at(await funded(w.chain));
    const judge = (await keyed(w)).signer.address;
    const url = "https://" + "example.org/kill-spec.md";
    const memos = (instructions: readonly Instruction[]) =>
      instructions.filter(({ programAddress }) => programAddress === MEMO_PROGRAM_ADDRESS).map(({ data }) => new TextDecoder().decode(Uint8Array.from(data ?? [])));
    const bare = await solive.payForWork({ amount: "1", judge, specHash: SPEC, preview: true });
    const linked = await solive.payForWork({ amount: "1", judge, specHash: SPEC, specUrl: url, preview: true });
    expect(memos(bare.instructions).join("")).not.toContain(url);
    expect(memos(linked.instructions).join("")).toContain(url);
  });
});

describe("the work reads and sends of the simple client", () => {
  it("lists the work of one judge when one is named and all work otherwise", async () => {
    const { w, at } = await devnet();
    const solive = await at(await funded(w.chain));
    const [first, second] = [(await keyed(w)).signer.address, (await keyed(w)).signer.address];
    const one = await solive.payForWork({ amount: "0.01", judge: first, specHash: SPEC });
    const two = await solive.payForWork({ amount: "0.02", judge: second, specHash: sha("the other spec") });
    const all = await solive.findWork();
    expect(all.map(({ intent }) => intent).sort()).toStrictEqual([one.intent, two.intent].sort());
    expect((await solive.findWork({ judge: first })).map(({ intent }) => intent)).toStrictEqual([one.intent]);
    expect((await solive.findWork({ judge: second })).map(({ intent }) => intent)).toStrictEqual([two.intent]);
  });

  it("names what is still held when a release or a cancel is previewed on a part-filled escrow", async () => {
    const { w, at, owner, worker, judge, escrow, announcement } = await released();
    const part = filledAt(w, escrow, 2_500_000n);
    const reviewer = await at(judge.signer, part);
    const preview = await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair, preview: true });
    expect(preview.summary).toBe(`Release escrow ${escrow} holding 0.0075 SOL to ${worker.address} for work ${WORK}, announced first in ${announcement}`);
    const buyer = await at(owner, part);
    expect((await buyer.cancel({ escrow, preview: true })).summary).toBe(`Cancel ${escrow} and return 0.0075 SOL to ${owner.address}`);
  });
});

describe("the receipt and deliveries of the simple client", () => {
  it("says to whom a released escrow was paid and for which work", async () => {
    const { w, buyer, reviewer, judge, worker, escrow } = await released();
    const done = await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    expect(w.chain.sent).toContain(done.signature);
    expect((await buyer.receipt({ escrow })).summary).toBe(`Escrow ${escrow} was released in ${done.signature} to ${worker.address} for work ${WORK}; the release is valid`);
  });

  it("names the work an announcement opens to among every candidate", async () => {
    const { buyer, reviewer, judge, worker, escrow, announcement } = await released();
    await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    expect(await buyer.deliveries({ escrow, sha256: sha("work nobody announced") })).toStrictEqual([
      { worker: worker.address, sha256: WORK, url: null, opened: false, announcement, seq: 1n },
    ]);
  });

  it("leaves the work of an announcement unnamed when the candidates do not open it", async () => {
    const { reviewer, judge, escrow } = await released(async (w, at, id) => {
      const other = await at(await funded(w.chain));
      await other.deliver({ escrow: id, sha256: sha("another piece of work"), url: workUrl("other.tar") });
    });
    const listed = await reviewer.deliveries({ escrow, sha256: sha("work nobody announced"), keypair: judge.keypair });
    expect(listed.map(({ sha256 }) => sha256)).toStrictEqual([null, null]);
  });

  it("is incomplete, with nobody refuting, when refutations cannot be listed", async () => {
    const { w, at, reviewer, judge, worker, escrow } = await released();
    await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    const { engineAccounts: _unlisted, ...blind } = w.chain.transport;
    const reader: SimpleClient<KeyPairSigner> = await at(worker, blind);
    expect(await reader.receipt({ escrow })).toMatchObject({ released: true, valid: true, refutedBy: null, complete: false, unreadable: [] });
  });

  it("is complete, and not valid, when the release names no announced work", async () => {
    const { w, at, reviewer, judge, worker, escrow } = await released();
    await reviewer.release({ escrow, deliveredSha256: WORK, keypair: judge.keypair });
    const reader = await at(worker, withoutDelivery(w.chain.transport));
    const receipt = await reader.receipt({ escrow });
    expect(receipt).toMatchObject({ released: true, deliveredSha256: null, valid: false, refutedBy: null, complete: true, unreadable: [] });
    expect(receipt.summary).toContain("for no announced work; the release is not valid");
  });
});
