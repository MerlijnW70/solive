import {
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { testSignature } from "../src/testing.js";
import { Kind } from "@intent-engine/core";
import { buildCreateIntent, buildInitUser, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { createClient, FailedOnChain, isSdkError, MaybeSent } from "../src/index.js";
import { failure, type RpcLike, rpcTransport, SYSTEM_PROGRAM_ADDRESS } from "../src/internal.js";
import { NOW, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const VALID_UNTIL = 100n;

type Landing = { err: unknown } | null;

function flakyNode() {
  const state = { sends: [] as string[], landed: null as Landing, blockHeight: 90n, slot: 500n, statusSlot: 500n, refuse: null as unknown };
  const signatureOf = (wire: string) => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: VALID_UNTIL } }) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        state.sends.push(wire);
        throw state.refuse ?? new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      },
    }),
    getSignatureStatuses: (signatures: Signature[]) => ({
      send: async () => ({
        context: { slot: state.statusSlot },
        value: signatures.map((signature) =>
          state.landed !== null && state.sends.some((wire) => signatureOf(wire) === signature) ? { ...state.landed, confirmationStatus: "confirmed", slot: 7n } : null,
        ),
      }),
    }),
    getEpochInfo: () => ({ send: async () => ({ blockHeight: state.blockHeight, absoluteSlot: state.slot }) }),
    getTransaction: () => ({ send: async () => null }),
  };
  const transport = rpcTransport(rpc as unknown as RpcLike, async () => undefined);
  return { state, transport, client: createClient({ url: LOCAL, transport }), signatureOf };
}

const transfer = (payer: KeyPairSigner, amount = 1n) => [getTransferSolInstruction({ source: payer, destination: payer.address, amount })];

describe("a send whose transaction may have reached the node", () => {
  it("throws MaybeSent with the signature when sendTransaction fails after the node took the bytes, sends once, and status resolves it", async () => {
    const payer = await generateKeyPairSigner();
    const node = flakyNode();
    const error = await node.transport.send(transfer(payer), payer).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MaybeSent);
    expect(node.state.sends).toHaveLength(1);
    const signature = node.signatureOf(node.state.sends[0] ?? "");
    expect(error).toMatchObject({ code: "maybe-sent", signature, lastValidBlockHeight: VALID_UNTIL });
    expect((error as MaybeSent).cause).toBeInstanceOf(TypeError);
    expect(await node.client.status(signature, VALID_UNTIL)).toEqual({ status: "pending", signature });
    node.state.landed = { err: null };
    expect(await node.client.status(signature, VALID_UNTIL)).toEqual({ status: "confirmed", signature, slot: 7n });
    expect(node.state.sends).toHaveLength(1);
  });

  it("reports expired for a transaction that never lands once the chain is past its last valid block height", async () => {
    const payer = await generateKeyPairSigner();
    const node = flakyNode();
    const error = await node.transport.send(transfer(payer), payer).catch((caught: unknown) => caught);
    if (!isSdkError(error, "maybe-sent")) {
      throw error;
    }
    expect(await node.client.status(error.signature, VALID_UNTIL)).toEqual({ status: "pending", signature: error.signature });
    node.state.blockHeight = VALID_UNTIL + 1n;
    node.state.statusSlot = node.state.slot - 1n;
    expect(await node.client.status(error.signature, VALID_UNTIL)).toEqual({ status: "pending", signature: error.signature });
    node.state.statusSlot = node.state.slot;
    expect(await node.client.status(error.signature, VALID_UNTIL)).toEqual({ status: "expired", signature: error.signature });
    expect(await node.client.status(error.signature)).toEqual({ status: "pending", signature: error.signature });
    expect(node.state.sends).toHaveLength(1);
  });

  it("wraps a non-JSON answer and a timeout from sendWire and submitWire the same way", async () => {
    const payer = await generateKeyPairSigner();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 55n }, m),
        (m) => appendTransactionMessageInstructions(transfer(payer), m),
      ),
    );
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const node = flakyNode();
    node.state.refuse = new SyntaxError("Unexpected token < in JSON at position 0");
    const garbled = await node.transport.sendWire(wire, { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 55n }).catch((caught: unknown) => caught);
    expect(garbled).toBeInstanceOf(MaybeSent);
    expect(garbled).toMatchObject({ signature, lastValidBlockHeight: 55n });
    node.state.refuse = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const late = await node.transport.submitWire(wire).catch((caught: unknown) => caught);
    expect(late).toBeInstanceOf(MaybeSent);
    expect(late).toMatchObject({ signature, lastValidBlockHeight: null });
    expect(node.state.sends).toHaveLength(2);
  });

  it("passes through a send the node never received", async () => {
    const payer = await generateKeyPairSigner();
    const node = flakyNode();
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), { code: "ECONNREFUSED" }) });
    node.state.refuse = refused;
    const error = await node.transport.send(transfer(payer), payer).catch((caught: unknown) => caught);
    expect(error).toBe(refused);
    expect(isSdkError(error)).toBe(false);
  });
});

describe("a transaction that lands and fails", () => {
  it("names the failing engine program, its logs and the decoded engine error, and status reports the same", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    await client.send([await buildInitUser({ owner: w.owner })], w.owner);
    const config = await client.config();
    const expired = await buildCreateIntent({
      owner: w.owner,
      treasury: config.feeRecipient,
      maxCreateFee: config.createFee,
      maxBounty: config.crankBounty,
      nonce: 0n,
      params: { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 50n },
      expiresAt: NOW - 1n,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const error = await w.chain.transport.send([expired], w.owner).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FailedOnChain);
    const failed = error as FailedOnChain;
    expect(failed.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(failed.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(failed.engine?.name).toBe("ExpiryNotInFuture");
    expect(failed.logs?.some((line) => line.startsWith(`Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x`))).toBe(true);
    expect(client.explain(failed)?.name).toBe("ExpiryNotInFuture");
    expect(await client.status(failed.signature as Signature)).toMatchObject({
      status: "failed",
      signature: failed.signature,
      program: INTENT_ENGINE_PROGRAM_ADDRESS,
      engine: { name: "ExpiryNotInFuture" },
    });
  });

  it("names another failing program and decodes no engine error for it", async () => {
    const w = await world();
    const poor = await generateKeyPairSigner();
    w.chain.svm.airdrop(poor.address, lamports(10_000_000n));
    const error = await w.chain.transport
      .send([getTransferSolInstruction({ source: poor, destination: w.owner.address, amount: 1_000_000_000n })], poor)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FailedOnChain);
    const failed = error as FailedOnChain;
    expect(failed.program).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(failed.engine).toBeUndefined();
    expect("engine" in failed).toBe(false);
    expect(failed.logs?.length).toBeGreaterThan(0);
    expect(failed.err).toEqual({ InstructionError: [0, { Custom: 1 }] });
  });

  it("decodes the engine error only for the engine, and from the instruction index when the node returned no logs", () => {
    const sig = testSignature("sent");
    const engineFirst = failure(sig, { InstructionError: [1, { Custom: 6003 }] }, undefined, [SYSTEM_PROGRAM_ADDRESS, INTENT_ENGINE_PROGRAM_ADDRESS]);
    expect(engineFirst).toMatchObject({ program: INTENT_ENGINE_PROGRAM_ADDRESS, engine: { code: 6003 } });
    expect("logs" in engineFirst).toBe(false);
    const other = failure(sig, { InstructionError: [0, { Custom: 6003 }] }, undefined, [SYSTEM_PROGRAM_ADDRESS, INTENT_ENGINE_PROGRAM_ADDRESS]);
    expect(other.program).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect("engine" in other).toBe(false);
    const inner = failure(sig, { InstructionError: [0, { Custom: 1 }] }, [
      `Program ${INTENT_ENGINE_PROGRAM_ADDRESS} invoke [1]`,
      `Program ${TOKEN_PROGRAM_ADDRESS} invoke [2]`,
      `Program ${TOKEN_PROGRAM_ADDRESS} failed: custom program error: 0x1`,
      `Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x1`,
    ], [INTENT_ENGINE_PROGRAM_ADDRESS]);
    expect(inner.program).toBe(TOKEN_PROGRAM_ADDRESS);
    expect("engine" in inner).toBe(false);
    expect(failure(sig, "AccountInUse").program).toBeNull();
  });
});
