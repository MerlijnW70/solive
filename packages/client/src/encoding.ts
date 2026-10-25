import { getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { InvalidInput } from "@intent-engine/core";

const HEX_PAIR = /^(?:[0-9a-fA-F]{2})*$/;

export const base64Bytes = (text: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(text));

export const bytesBase64 = (bytes: Uint8Array): string => getBase64Decoder().decode(bytes);

export const bytesHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function hexBytes(hex: string): Uint8Array {
  if (!HEX_PAIR.test(hex)) {
    throw new InvalidInput("hex", "format", "hex text must be an even run of hex digits");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

export function joinedBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}
