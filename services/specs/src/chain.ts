import { getAddressDecoder, getBase58Decoder, getBase64Encoder, type Address, type Base58EncodedBytes, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { ATTESTED_ATTESTOR_AT, INTENT_KIND_AT } from "@intent-engine/client/internal";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { DEVNET_GENESIS_HASH, NODE_TIMEOUT_MS } from "./limits.js";

export type MirrorRpc = Rpc<SolanaRpcApi>;

export type OpenEscrow = { readonly owner: Address; readonly inputMint: Address; readonly escrowed: bigint };

export const SPEC_HASH_AT = ATTESTED_ATTESTOR_AT + 32;
export const ESCROW_SLICE = { offset: 8, length: 144 } as const;

const OWNER_IN_SLICE = 0;
const MINT_IN_SLICE = 32;
const ESCROWED_IN_SLICE = 136;
const HASH_BYTES = 32;

const memcmp = (offset: number, bytes: ArrayLike<number>) => ({
  memcmp: { offset: BigInt(offset), bytes: getBase58Decoder().decode(Uint8Array.from(bytes)) as Base58EncodedBytes, encoding: "base58" as const },
});

const openAttested = () => [{ dataSize: BigInt(getIntentSize()) }, memcmp(0, getIntentDiscriminatorBytes()), memcmp(INTENT_KIND_AT, [Kind.AttestedResult, IntentStatus.Open])];

export const escrowFilters = (hex: string) => [...openAttested(), memcmp(SPEC_HASH_AT, Buffer.from(hex, "hex"))];

export async function onDevnet(rpc: MirrorRpc): Promise<boolean> {
  const genesis = await rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  return genesis === DEVNET_GENESIS_HASH;
}

const sliceOf = (data: readonly [string, string], length: number): Uint8Array => {
  const bytes = Uint8Array.from(getBase64Encoder().encode(data[0]));
  if (bytes.length !== length) throw new Error("the node answered a slice of another length");
  return bytes;
};

export async function openEscrowsOf(rpc: MirrorRpc, hex: string): Promise<OpenEscrow[]> {
  const found = await rpc
    .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, { encoding: "base64", commitment: "confirmed", dataSlice: ESCROW_SLICE, filters: escrowFilters(hex) })
    .send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  const addresses = getAddressDecoder();
  return found.map(({ account }) => {
    const bytes = sliceOf(account.data, ESCROW_SLICE.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      owner: addresses.decode(bytes.subarray(OWNER_IN_SLICE, OWNER_IN_SLICE + 32)),
      inputMint: addresses.decode(bytes.subarray(MINT_IN_SLICE, MINT_IN_SLICE + 32)),
      escrowed: view.getBigUint64(ESCROWED_IN_SLICE, true),
    };
  });
}

export const BACKING_SLICE = { offset: 40, length: 224 } as const;

const MINT_IN_BACKING = 0;
const ESCROWED_IN_BACKING = 104;
const HASH_IN_BACKING = SPEC_HASH_AT - BACKING_SLICE.offset;

export async function openBacking(rpc: MirrorRpc, mint: Address): Promise<Map<string, bigint>> {
  const found = await rpc
    .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, { encoding: "base64", commitment: "confirmed", dataSlice: BACKING_SLICE, filters: openAttested() })
    .send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  const addresses = getAddressDecoder();
  const locked = new Map<string, bigint>();
  for (const { account } of found) {
    const bytes = sliceOf(account.data, BACKING_SLICE.length);
    const hex = Buffer.from(bytes.subarray(HASH_IN_BACKING, HASH_IN_BACKING + HASH_BYTES)).toString("hex");
    const escrowed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(ESCROWED_IN_BACKING, true);
    const counted = addresses.decode(bytes.subarray(MINT_IN_BACKING, MINT_IN_BACKING + 32)) === mint ? escrowed : 0n;
    locked.set(hex, (locked.get(hex) ?? 0n) + counted);
  }
  return locked;
}

export const PAID_SLICE = { offset: 40, length: INTENT_KIND_AT + 2 - 40 } as const;

const STATUS_IN_PAID = INTENT_KIND_AT + 1 - PAID_SLICE.offset;
const PAYING: ReadonlySet<number> = new Set([IntentStatus.Filled, IntentStatus.Filling]);

export async function paidBacking(rpc: MirrorRpc, hex: string, mint: Address): Promise<bigint> {
  const found = await rpc
    .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: PAID_SLICE,
      filters: [{ dataSize: BigInt(getIntentSize()) }, memcmp(0, getIntentDiscriminatorBytes()), memcmp(INTENT_KIND_AT, [Kind.AttestedResult]), memcmp(SPEC_HASH_AT, Buffer.from(hex, "hex"))],
    })
    .send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  const addresses = getAddressDecoder();
  let paid = 0n;
  for (const { account } of found) {
    const bytes = sliceOf(account.data, PAID_SLICE.length);
    if (!PAYING.has(bytes[STATUS_IN_PAID] as number) || addresses.decode(bytes.subarray(MINT_IN_BACKING, MINT_IN_BACKING + 32)) !== mint) continue;
    paid += new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(ESCROWED_IN_BACKING, true);
  }
  return paid;
}
