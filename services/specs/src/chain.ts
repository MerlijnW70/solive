import { getBase58Decoder, type Base58EncodedBytes, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { ATTESTED_ATTESTOR_AT, INTENT_KIND_AT } from "@intent-engine/client/internal";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { DEVNET_GENESIS_HASH, NODE_TIMEOUT_MS } from "./limits.js";

export type MirrorRpc = Rpc<SolanaRpcApi>;

export const SPEC_HASH_AT = ATTESTED_ATTESTOR_AT + 32;

const memcmp = (offset: number, bytes: ArrayLike<number>) => ({
  memcmp: { offset: BigInt(offset), bytes: getBase58Decoder().decode(Uint8Array.from(bytes)) as Base58EncodedBytes, encoding: "base58" as const },
});

export const escrowFilters = (hex: string) => [
  { dataSize: BigInt(getIntentSize()) },
  memcmp(0, getIntentDiscriminatorBytes()),
  memcmp(INTENT_KIND_AT, [Kind.AttestedResult, IntentStatus.Open]),
  memcmp(SPEC_HASH_AT, Buffer.from(hex, "hex")),
];

export async function onDevnet(rpc: MirrorRpc): Promise<boolean> {
  const genesis = await rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  return genesis === DEVNET_GENESIS_HASH;
}

export async function openEscrowHolds(rpc: MirrorRpc, hex: string): Promise<boolean> {
  const found = await rpc
    .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
      filters: escrowFilters(hex),
    })
    .send({ abortSignal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  return found.length > 0;
}
