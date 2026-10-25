import { type Address, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS } from "@intent-engine/solver";
import { ESCROW } from "./harness.js";

export type Json = Record<string, unknown>;

export function unitLimitOf(wire: string): number | null {
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes,
  );
  const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET_ADDRESS);
  const instructions = "instructions" in message ? message.instructions : [];
  const set = instructions.find((ix) => ix.programAddressIndex === budget && ix.data?.[0] === 2);
  return set?.data === undefined ? null : new DataView(set.data.buffer, set.data.byteOffset).getUint32(1, true);
}

export const createSwap = (inputMint: Address, outputMint: Address, nonce: string, expiresAt: bigint) => [
  "create",
  "swap",
  "--keypair",
  "owner.json",
  "--nonce",
  nonce,
  "--input-mint",
  inputMint,
  "--output-mint",
  outputMint,
  "--expires-at",
  expiresAt.toString(),
  "--amount-in",
  ESCROW.toString(),
  "--min-out",
  "300",
  "--units",
  "raw",
  "--url",
  "http://cluster",
  "--yes",
];
