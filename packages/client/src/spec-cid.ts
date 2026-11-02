import { InvalidInput } from "@intent-engine/core";
import { bytesHex, hexBytes } from "./encoding.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const RAW_SHA256_PREFIX: readonly number[] = [0x01, 0x55, 0x12, 0x20];
const SPEC_HASH = /^[0-9a-f]{64}$/;
const CID_TEXT = /^b[a-z2-7]+$/;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

function unbase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function cidOfSpecHash(hex: string): string {
  if (!SPEC_HASH.test(hex)) {
    throw new InvalidInput("hex", "format", "a spec hash is 64 lowercase hex digits");
  }
  return "b" + base32(Uint8Array.from([...RAW_SHA256_PREFIX, ...hexBytes(hex)]));
}

export function specHashOfCid(cid: string): string | null {
  if (!CID_TEXT.test(cid)) {
    return null;
  }
  const hex = bytesHex(unbase32(cid.slice(1)).subarray(RAW_SHA256_PREFIX.length));
  return SPEC_HASH.test(hex) && cidOfSpecHash(hex) === cid ? hex : null;
}
