import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, getIntentDiscriminatorBytes, getIntentSize, NATIVE_MINT } from "@intent-engine/core";
import { BehindMinSlot, BlockhashExpired, FailedOnChain, isSdkError, type RpcLike, rpcTransport, type Transport } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";

const NOT_ON_LITESVM: Readonly<Record<string, string>> = {
  finalizedBlock: "LiteSVM produces no blocks, so it has no finalized block and no blockhash of one to read",
};

const everyOptionalRpc = {
  getFirstAvailableBlock: () => ({ send: async () => 0n }),
  getBlocksWithLimit: () => ({ send: async () => [] }),
  getBlock: () => ({ send: async () => null }),
} as unknown as RpcLike;

const NOW = 1_700_000_000n;

async function signed(transport: Transport, payer: KeyPairSigner, instructions: readonly Instruction[]) {
  const latest = await transport.latestBlockhash();
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), latest };
}

const overdraw = (from: KeyPairSigner, to: Address) => [getTransferSolInstruction({ source: from, destination: to, amount: 1_000_000_000_000n })];

async function escrow(world: TestWorld, owner: KeyPairSigner) {
  const judge = await world.wallet();
  const params = attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(9), judgeFee: 0n });
  return world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
}

describe("the svm transport against the RPC transport", () => {
  it("implements every method the RPC transport implements, except those LiteSVM cannot have, each listed with its reason", () => {
    const rpcMethods = Object.keys(rpcTransport(everyOptionalRpc)).sort();
    const svmMethods = new Set(Object.keys(svmTransport(new LiteSVM())));
    expect(rpcMethods.filter((method) => !svmMethods.has(method))).toEqual(Object.keys(NOT_ON_LITESVM).sort());
    for (const reason of Object.values(NOT_ON_LITESVM)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("lists signatures newest first with paging, and reads each transaction back from history", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    const first = await escrow(world, owner);
    const second = await escrow(world, owner);
    const listed = await world.transport.signaturesOf?.(owner.address, 1);
    expect(listed?.map(({ signature, failed }) => [signature, failed])).toEqual([[second.signature, false]]);
    const next = await world.transport.signaturesOf?.(owner.address, 5, second.signature);
    expect(next?.map(({ signature }) => signature)).toEqual([first.signature]);
    const read = await world.transport.transactionsOf?.([...(listed ?? []), ...(next ?? [])]);
    expect(read?.map(({ signature }) => signature)).toEqual([second.signature, first.signature]);
    expect((await world.transport.transactionOf?.(first.signature))?.feePayer).toBe(owner.address);
    expect((await world.transport.engineTransactions(5, owner.address)).map(({ signature }) => signature)).toEqual([second.signature, first.signature]);
    expect(await world.transport.signatureStatuses?.([first.signature, "1".repeat(64)])).toEqual(["landed", null]);
  });

  it("lists engine accounts with filters from the chain itself, also those another transport or setAccount made", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    const other = await world.wallet();
    const mine = await escrow(world, owner);
    const theirs = await escrow(world, other);
    const fresh = svmTransport(world.svm);
    const intentFilter = { discriminator: getIntentDiscriminatorBytes(), dataSize: getIntentSize() };
    expect((await fresh.engineAccounts?.(intentFilter))?.map(({ address }) => address).sort()).toEqual([mine.intent, theirs.intent].sort());
    const owned = await fresh.engineAccounts?.({ ...intentFilter, match: [{ offset: 8, address: owner.address }] });
    expect(owned?.map(({ address }) => address)).toEqual([mine.intent]);
    expect(await fresh.engineAccounts?.({ ...intentFilter, dataSize: getIntentSize() + 1 })).toEqual([]);
    const copy = (await world.wallet(0)).address;
    const held = world.svm.getAccount(mine.intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    world.svm.setAccount({ ...held, address: copy });
    expect((await fresh.intents({ owner: owner.address })).map(({ address }) => address).sort()).toEqual([mine.intent, copy].sort());
    expect((await fresh.engineAccounts?.())?.every(({ data }) => data.length > 0)).toBe(true);
  });

  it("reports the slot it read intents at and refuses a read from before a slot already seen", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    await escrow(world, owner);
    world.svm.warpToSlot(40n);
    const heard: bigint[] = [];
    expect(await world.transport.intents({ owner: owner.address }, { minContextSlot: 40n, onSlot: (slot) => heard.push(slot) })).toHaveLength(1);
    expect(heard).toEqual([40n]);
    const behind = await world.transport.intents({ owner: owner.address }, { minContextSlot: 41n }).catch((error: unknown) => error);
    expect(behind).toBeInstanceOf(BehindMinSlot);
    expect(behind).toMatchObject({ slot: 40n, minContextSlot: 41n });
  });

  it("throws FailedOnChain for a send that lands and fails, and its status, statuses and history say failed", async () => {
    const world = await createTestWorld({ start: NOW });
    const poor = await world.wallet("0.01");
    const error = await world.transport.send(overdraw(poor, world.admin.address), poor).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FailedOnChain);
    const signature = (error as FailedOnChain).signature;
    expect((error as FailedOnChain).err).toEqual({ InstructionError: [0, { Custom: 1 }] });
    expect(await world.client.status(signature)).toMatchObject({ status: "failed", signature, err: { InstructionError: [0, { Custom: 1 }] } });
    expect(await world.transport.signatureStatuses?.([signature])).toEqual(["failed"]);
    expect((await world.transport.signaturesOf?.(poor.address, 5))?.map(({ signature: listed, failed }) => [listed, failed])).toEqual([[signature, true]]);
    expect((await world.transport.transactionOf?.(signature))?.failed).toBe(true);
  });

  it("returns the signature of a submitted wire that fails without confirming it, as a send that skips preflight does, and status says failed", async () => {
    const world = await createTestWorld({ start: NOW });
    const poor = await world.wallet("0.01");
    const { wire, signature } = await signed(world.transport, poor, overdraw(poor, world.admin.address));
    expect(await world.transport.submitWire(wire)).toBe(signature);
    expect(await world.client.status(signature)).toMatchObject({ status: "failed", signature });
    const again = await world.transport.sendWire(wire, await world.transport.latestBlockhash()).catch((caught: unknown) => caught);
    expect(isSdkError(again, "failed-on-chain")).toBe(true);
  });

  it("refuses a wire whose blockhash has moved on with BlockhashExpired, records nothing, and status says expired", async () => {
    const world = await createTestWorld({ start: NOW });
    const payer = await world.wallet();
    const { wire, signature, latest } = await signed(world.transport, payer, [getTransferSolInstruction({ source: payer, destination: world.admin.address, amount: 1n })]);
    expect(await world.client.status(signature as Signature, latest.lastValidBlockHeight)).toEqual({ status: "pending", signature });
    await world.wallet().then((other) => world.transport.send([getTransferSolInstruction({ source: other, destination: world.admin.address, amount: 1n })], other));
    expect((await world.transport.latestBlockhash()).lastValidBlockHeight).toBeGreaterThan(latest.lastValidBlockHeight);
    await expect(world.transport.sendWire(wire, latest)).rejects.toThrow(BlockhashExpired);
    expect(await world.transport.signatureStatuses?.([signature])).toEqual([null]);
    expect(await world.client.status(signature as Signature, latest.lastValidBlockHeight)).toEqual({ status: "expired", signature });
    expect(await world.client.status(signature as Signature)).toEqual({ status: "pending", signature });
  });

  it("resolves a signature the way client.status resolves a MaybeSent one: pending before it lands, confirmed after, and a resend returns it", async () => {
    const world = await createTestWorld({ start: NOW });
    const payer = await world.wallet();
    const { wire, signature, latest } = await signed(world.transport, payer, [getTransferSolInstruction({ source: payer, destination: world.admin.address, amount: 5n })]);
    expect(await world.client.status(signature as Signature, latest.lastValidBlockHeight)).toEqual({ status: "pending", signature });
    expect(await world.transport.sendWire(wire, latest)).toBe(signature);
    const slot = world.svm.getClock().slot;
    expect(await world.client.status(signature as Signature, latest.lastValidBlockHeight)).toEqual({ status: "confirmed", signature, slot });
    expect(await world.transport.sendWire(wire, latest)).toBe(signature);
    expect((await world.transport.signaturesOf?.(payer.address, 5))?.map(({ signature: listed }) => listed)).toEqual([signature]);
  });
});
