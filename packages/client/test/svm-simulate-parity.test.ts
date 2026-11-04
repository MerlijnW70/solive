import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { type RpcLike, rpcTransport } from "../src/internal.js";
import type { Simulation, Transport } from "../src/index.js";
import { createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";

const noWait = async () => undefined;

async function wireOf(world: TestWorld, payer: TestWallet, to: Address, amount: bigint, source: TestWallet = payer): Promise<Base64EncodedWireTransaction> {
  const latest = await world.transport.latestBlockhash();
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source, destination: to, amount })], m),
    ),
  );
  return getBase64EncodedWireTransaction({ ...compiled, signatures: { [payer.address]: new Uint8Array(64) as SignatureBytes, [source.address]: new Uint8Array(64) as SignatureBytes } });
}

const readerOf = async (transport: Transport, wire: Base64EncodedWireTransaction, watch: readonly Address[]) => {
  const read: Simulation = await transport.simulate(wire, watch);
  return {
    keys: Object.keys(read).sort(),
    err: read.err,
    logsAreText: read.logs.every((line) => typeof line === "string"),
    units: read.unitsConsumed === null ? null : typeof read.unitsConsumed,
    accounts: read.accounts.map((data) => (data === null ? null : Array.from(data))),
  };
};

const nodeAnswering = (value: unknown): RpcLike =>
  ({ simulateTransaction: () => ({ send: async () => ({ context: { slot: 1n }, value }) }) }) as unknown as RpcLike;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("simulating on the test chain and on a node", () => {
  it("reads a failed transfer the same way on both", async () => {
    const world = await createTestWorld();
    const payer = await world.wallet(1);
    const to = await world.wallet(0);
    const watched = await world.wallet(0);
    const wire = await wireOf(world, payer, to.address, 5_000_000_000n);
    const onChain = await readerOf(world.transport, wire, [payer.address, watched.address]);
    const node = nodeAnswering({
      err: { InstructionError: [0, { Custom: 1 }] },
      logs: ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports"],
      unitsConsumed: 150n,
      accounts: [null, null],
    });
    const viaNode = await readerOf(rpcTransport(node, noWait), wire, [payer.address, watched.address]);
    expect(onChain.err).toBe("{ InstructionError: [ 0, { Custom: 1 } ] }");
    expect(onChain).toEqual(viaNode);
    expect(onChain.accounts).toEqual([null, null]);
  });

  it("reads a transfer that would land the same way on both, with the watched balances after it", async () => {
    const world = await createTestWorld();
    const payer = await world.wallet(1);
    const to = await world.wallet(0);
    const wire = await wireOf(world, payer, to.address, 1_000_000n);
    const onChain = await readerOf(world.transport, wire, [to.address]);
    expect(onChain.err).toBeNull();
    const viaNode = await readerOf(rpcTransport(nodeAnswering({ err: null, logs: [], unitsConsumed: 150n, accounts: [{ data: [base64(new Uint8Array()), "base64"] }] }), noWait), wire, [to.address]);
    expect(onChain.keys).toEqual(viaNode.keys);
    expect(onChain.units).toBe(viaNode.units);
    expect(onChain.accounts).toEqual(viaNode.accounts);
    expect(onChain.accounts).toEqual([[]]);
  });

  it("returns the bytes of a watched account a transfer drains to zero lamports, as a node does", async () => {
    const world = await createTestWorld();
    const payer = await world.wallet(1);
    const drained = await world.wallet("0.001");
    const wire = await wireOf(world, payer, payer.address, 1_000_000n, drained);
    const onChain = await readerOf(world.transport, wire, [drained.address]);
    expect(onChain.err).toBeNull();
    const viaNode = await readerOf(rpcTransport(nodeAnswering({ err: null, logs: [], unitsConsumed: 150n, accounts: [{ data: [base64(new Uint8Array()), "base64"] }] }), noWait), wire, [drained.address]);
    expect(onChain.accounts).toEqual([[]]);
    expect(onChain.accounts).toEqual(viaNode.accounts);
  });
});
