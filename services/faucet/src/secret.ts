import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

export const SECRET_BYTES = 64;

function bytesOf(raw: string): Uint8Array | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== SECRET_BYTES) return undefined;
  if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return undefined;
  return Uint8Array.from(value as number[]);
}

export async function faucetSigner(raw: string | undefined): Promise<KeyPairSigner | undefined> {
  if (raw === undefined) return undefined;
  const bytes = bytesOf(raw);
  if (bytes === undefined) return undefined;
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    return undefined;
  } finally {
    bytes.fill(0);
  }
}
