import { type Address, getAddressDecoder } from "@solana/kit";

export const LOOKUP_TABLE_HEADER = 56;
const LOOKUP_TABLE_TAG = 1;

export function decodeLookupTable(data: Uint8Array): Address[] {
  if (data.length < LOOKUP_TABLE_HEADER || (data.length - LOOKUP_TABLE_HEADER) % 32 !== 0) {
    throw new Error(`a lookup table of ${data.length} bytes is malformed`);
  }
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (tag !== LOOKUP_TABLE_TAG) {
    throw new Error(`account is not a lookup table (tag ${tag})`);
  }
  const decoder = getAddressDecoder();
  const out: Address[] = [];
  for (let at = LOOKUP_TABLE_HEADER; at < data.length; at += 32) {
    out.push(decoder.decode(data.subarray(at, at + 32)));
  }
  return out;
}
