import {
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getSolanaErrorFromJsonRpcError,
  isSolanaError,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { BlockhashExpired, Charged, FailedOnChain, neverLanded, type RpcLike, rpcTransport } from "../src/index.js";

type Status = { err: unknown; confirmationStatus: string | null; slot?: bigint };

const LATEST = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 10n };

const preflight = (err: unknown) =>
  getSolanaErrorFromJsonRpcError({
    code: -32002,
    message: "Transaction simulation failed",
    data: {
      err,
      logs: [],
      accounts: null,
      unitsConsumed: 0,
      returnData: null,
      innerInstructions: null,
      replacementBlockhash: null,
      loadedAccountsDataSize: 0,
      fee: null,
      preBalances: null,
      postBalances: null,
      preTokenBalances: null,
      postTokenBalances: null,
      loadedAddresses: null,
    },
  });

const tooMany = () => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 });

const transfer = (payer: KeyPairSigner) => [getTransferSolInstruction({ source: payer, destination: payer.address, amount: 1n })];

async function wired(payer: KeyPairSigner) {
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(LATEST, m),
      (m) => appendTransactionMessageInstructions(transfer(payer), m),
    ),
  );
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}

function refusing(sends: unknown[], landed: Status | null = null) {
  const calls: string[] = [];
  const asked: Signature[] = [];
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: LATEST }) }),
    sendTransaction: () => ({
      send: async () => {
        calls.push("send");
        throw sends.shift();
      },
    }),
    getSignatureStatuses: (signatures: Signature[], config?: { searchTransactionHistory: boolean }) => ({
      send: async () => {
        calls.push(config?.searchTransactionHistory === true ? "status:history" : "status");
        asked.push(...signatures);
        return { context: { slot: 100n }, value: [landed] };
      },
    }),
    getEpochInfo: () => ({
      send: async () => {
        calls.push("epoch");
        return { blockHeight: 0n, absoluteSlot: 0n };
      },
    }),
  };
  return { calls, asked, transport: rpcTransport(rpc as unknown as RpcLike, async () => undefined) };
}

const failure = (pending: Promise<unknown>) => pending.then(() => null, (error: unknown) => error);

describe("a node that refuses a transaction for its stale blockhash", () => {
  it("reports sendWire as expired, not charged, once the node has no status for the wire's signature", async () => {
    const payer = await generateKeyPairSigner();
    const { wire, signature } = await wired(payer);
    const refusal = preflight("BlockhashNotFound");
    const { calls, asked, transport } = refusing([refusal]);
    const error = await failure(transport.sendWire(wire, LATEST));
    expect(error).toBeInstanceOf(BlockhashExpired);
    expect(error).not.toBeInstanceOf(Charged);
    expect(neverLanded(error)).toBe(true);
    expect((error as Error).message).toContain("nothing was charged");
    expect((error as Error).cause).toBe(refusal);
    expect(calls).toEqual(["send", "status:history"]);
    expect(asked).toEqual([signature]);
  });

  it("reports send as expired too", async () => {
    const payer = await generateKeyPairSigner();
    const { calls, transport } = refusing([preflight("BlockhashNotFound")]);
    const error = await failure(transport.send(transfer(payer), payer));
    expect(error).toBeInstanceOf(BlockhashExpired);
    expect(calls).toEqual(["send", "status:history"]);
  });

  it("reports the landing when a retried send is refused for its blockhash after the first attempt landed", async () => {
    const payer = await generateKeyPairSigner();
    const { wire, signature } = await wired(payer);
    const landed: Status = { confirmationStatus: "confirmed", err: null, slot: 77n };
    const { calls, asked, transport } = refusing([tooMany(), preflight("BlockhashNotFound")], landed);
    expect(await transport.sendWire(wire, LATEST)).toBe(signature);
    expect(calls).toEqual(["send", "send", "status:history", "status"]);
    expect(asked).toEqual([signature, signature]);
  });

  it("reports a failed landing as charged when the retry is refused for its blockhash", async () => {
    const payer = await generateKeyPairSigner();
    const { wire } = await wired(payer);
    const failed: Status = { confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] }, slot: 77n };
    const { transport } = refusing([tooMany(), preflight("BlockhashNotFound")], failed);
    const error = await failure(transport.sendWire(wire, LATEST));
    expect(error).toBeInstanceOf(FailedOnChain);
    expect(error).toBeInstanceOf(Charged);
    expect(error).not.toBeInstanceOf(BlockhashExpired);
  });

  it("passes any other preflight refusal through unchanged", async () => {
    const payer = await generateKeyPairSigner();
    const { wire } = await wired(payer);
    const refusal = preflight("InsufficientFundsForFee");
    const { calls, transport } = refusing([refusal]);
    const error = await failure(transport.sendWire(wire as Base64EncodedWireTransaction, LATEST));
    expect(error).toBe(refusal);
    expect(isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)).toBe(true);
    expect(neverLanded(error)).toBe(false);
    expect(calls).toEqual(["send"]);
  });
});
