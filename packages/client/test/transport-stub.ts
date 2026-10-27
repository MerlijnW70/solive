import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { afterEach, beforeEach, vi } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { testSignature } from "../src/testing.js";
import { type RpcLike, MEMO_PROGRAM_ADDRESS } from "../src/transport.js";

export const SIG = testSignature("sig");
export const OWNER = "11111111111111111111111111111112" as Address;
export const OTHER = "So11111111111111111111111111111111111111112" as Address;
export const OTHER_SIG = testSignature("other sig");
export async function signedWire(): Promise<Base64EncodedWireTransaction> {
  const payer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 10n }, m),
  );
  return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
}
export const signatureOfWire = (wire: string): Signature => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

export type Status = { err: unknown; confirmationStatus: string | null } | null;

export function stub(statuses: Status[], heights: bigint[] = [0n], seen: bigint[] = []) {
  const calls: string[] = [];
  const sent: string[] = [];
  const rpc = {
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async () => {
        calls.push(`many:${addresses.length}`);
        return {
          value: addresses.map((address) =>
            address === OWNER
              ? { owner: OWNER, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"] as const, lamports: 7n, executable: true }
              : null,
          ),
        };
      },
    }),
    getAccountInfo: (address: Address) => ({
      send: async () => ({
        value:
          address === OWNER
            ? { owner: OWNER, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"] as const, lamports: 7n, executable: true }
            : null,
      }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 10n },
      }),
    }),
    sendTransaction: (wire: string, config: { encoding: string }) => ({
      send: async () => {
        calls.push(`send:${config.encoding}`);
        sent.push(wire);
        return signatureOfWire(wire);
      },
    }),
    simulateTransaction: (
      wire: string,
      config: {
        encoding: string;
        sigVerify: boolean;
        replaceRecentBlockhash: boolean;
        accounts?: { addresses: Address[]; encoding: "base64" };
      },
    ) => ({
      send: async () => {
        calls.push(
          `simulate:${wire}:${config.encoding}:${config.sigVerify}:${config.replaceRecentBlockhash}${config.accounts === undefined ? "" : `:${config.accounts.addresses.join(",")}`}`,
        );
        const accounts = config.accounts?.addresses.map((a, i) =>
          i === 0 ? { data: [Buffer.from([7, 8]).toString("base64"), "base64"] as const } : null,
        );
        return wire === "ok"
          ? { value: { err: null, logs: ["Program log: fine"], unitsConsumed: 1_234n, ...(accounts === undefined ? {} : { accounts }) } }
          : { value: { err: { InstructionError: [1, { Custom: 6010 }] }, logs: null } };
      },
    }),
    getSignatureStatuses: (signatures: Signature[], config?: { searchTransactionHistory: boolean }) => ({
      send: async () => {
        calls.push(`status:${signatures.join(",")}${config?.searchTransactionHistory === true ? ":history" : ""}`);
        return { context: { slot: seen.shift() ?? 1_000_000n }, value: [statuses.shift() ?? null] };
      },
    }),
    getEpochInfo: () => ({
      send: async () => {
        calls.push("epoch");
        const blockHeight = heights.shift() ?? 0n;
        return { blockHeight, absoluteSlot: blockHeight + 100n };
      },
    }),
    getGenesisHash: () => ({ send: async () => "GENESIS" }),
    getRecentPrioritizationFees: (addresses: readonly Address[]) => ({
      send: async () => {
        calls.push(`fees:${addresses.join(",")}`);
        return [{ prioritizationFee: 5n }, { prioritizationFee: 9n }];
      },
    }),
    getSignaturesForAddress: (address: Address, config: { limit: number }) => ({
      send: async () => {
        calls.push(`signatures:${address}:${config.limit}`);
        return [
          { signature: SIG, slot: 7n, blockTime: 100n, err: null },
          { signature: OTHER_SIG, slot: 8n, blockTime: null, err: { InstructionError: [0, "x"] } },
        ];
      },
    }),
    getTransaction: (signature: Signature, config: { encoding: string; maxSupportedTransactionVersion: number; commitment: string }) => ({
      send: async () => {
        calls.push(`transaction:${signature}:${config.encoding}:${config.maxSupportedTransactionVersion}:${config.commitment}`);
        return signature === SIG
          ? {
              transaction: {
                signatures: [signature],
                message: {
                  accountKeys: [OWNER, INTENT_ENGINE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS],
                  header: { numRequiredSignatures: 1 },
                  instructions: [
                    { programIdIndex: 2, accounts: [0, 1], data: getBase58Decoder().decode(new TextEncoder().encode("delivery note")) },
                    { programIdIndex: 1, data: getBase58Decoder().decode(new TextEncoder().encode("not a memo")) },
                  ],
                },
              },
              meta: {
                loadedAddresses: { writable: [TOKEN_PROGRAM], readonly: [INTENT_ENGINE_PROGRAM_ADDRESS] },
                innerInstructions: [
                  { instructions: [{ programIdIndex: 1, data: getBase58Decoder().decode(new Uint8Array([1, 2])) }] },
                  {
                    instructions: [
                      { programIdIndex: 3, data: getBase58Decoder().decode(new Uint8Array([3])) },
                      { programIdIndex: 4, data: getBase58Decoder().decode(new Uint8Array([4, 5])) },
                      { programIdIndex: 0, data: getBase58Decoder().decode(new Uint8Array([6])) },
                    ],
                  },
                ],
              },
            }
          : null;
      },
    }),
    requestAirdrop: (address: Address, lamports: bigint) => ({
      send: async () => {
        calls.push(`airdrop:${address}:${lamports}`);
        return SIG;
      },
    }),
    getProgramAccounts: (program: Address, config: { encoding: string; filters: readonly unknown[] }) => ({
      send: async () => {
        calls.push(`program-accounts:${program}:${JSON.stringify(config, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
        return [{ pubkey: OWNER, account: { data: [Buffer.from([7, 8]).toString("base64"), "base64"] as const } }];
      },
    }),
  } satisfies RpcLike;
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return { rpc, calls, sent, waits, wait };
}

export function isolateMocks() {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
