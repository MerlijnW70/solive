import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { IntentCoreError, InvalidInput } from "./errors.js";

export const EXT_MAX_LEN = 512;
export const KNOWN_FLAGS = 0;
export const PARTNER_TAG = 1;
export const PARTNER_LEN = 34;
export const MAX_PARTNER_BPS = 100;
export const CREATE_EXT_TAGS: readonly number[] = [PARTNER_TAG];
export const FILL_EXT_TAGS: readonly number[] = [];
export const SETTLE_EXT_TAGS: readonly number[] = [];

export type ExtField = { tag: number; value: Uint8Array };

export function checkFlags(flags: number): number {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff) {
    throw new InvalidInput("flags", "range", `${flags} is not a u16 flag set`);
  }
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new IntentCoreError("FlagsUnknown");
  }
  return flags;
}

function fieldsOf(ext: Uint8Array): ExtField[] {
  const out: ExtField[] = [];
  let at = 0;
  while (at < ext.length) {
    const tag = ext[at] ?? 0;
    const len = (ext[at + 1] ?? 0) | ((ext[at + 2] ?? 0) << 8);
    const end = at + 3 + len;
    if (end > ext.length) {
      throw new IntentCoreError("ExtMalformed");
    }
    out.push({ tag, value: ext.subarray(at + 3, end) });
    at = end;
  }
  return out;
}

export function validateExt(ext: Uint8Array, known: readonly number[]): Uint8Array {
  if (ext.length > EXT_MAX_LEN) {
    throw new IntentCoreError("ExtTooLong");
  }
  let last = 0;
  for (const { tag } of fieldsOf(ext)) {
    if (tag <= last) {
      throw new IntentCoreError("ExtMalformed");
    }
    if (!known.includes(tag)) {
      throw new IntentCoreError("ExtUnknown");
    }
    last = tag;
  }
  return ext;
}

export function encodeExt(fields: readonly ExtField[]): Uint8Array {
  const parts: number[] = [];
  let last = 0;
  for (const { tag, value } of fields) {
    if (!Number.isInteger(tag) || tag <= last || tag > 255) {
      throw new InvalidInput("ext", "order", `extension tags must rise strictly within 1..255, got ${tag} after ${last}`);
    }
    parts.push(tag, value.length & 0xff, value.length >> 8, ...value);
    last = tag;
  }
  if (parts.length > EXT_MAX_LEN) {
    throw new IntentCoreError("ExtTooLong");
  }
  return Uint8Array.from(parts);
}

export function findExt(ext: Uint8Array, tag: number): Uint8Array | undefined {
  return fieldsOf(ext).find((f) => f.tag === tag)?.value;
}

export type Partner = { key: Address; bps: number };

export function encodePartner(partner: Partner): Uint8Array {
  if (!Number.isInteger(partner.bps) || partner.bps < 1 || partner.bps > MAX_PARTNER_BPS) {
    throw new InvalidInput("bps", "range", `a partner share must be 1 to ${MAX_PARTNER_BPS} bps, got ${partner.bps}`);
  }
  const value = new Uint8Array(PARTNER_LEN);
  value.set(getAddressEncoder().encode(partner.key));
  new DataView(value.buffer).setUint16(32, partner.bps, true);
  return encodeExt([{ tag: PARTNER_TAG, value }]);
}

export function partnerOf(ext: Uint8Array): Partner | undefined {
  validateExt(ext, CREATE_EXT_TAGS);
  const value = findExt(ext, PARTNER_TAG);
  if (value === undefined) {
    return undefined;
  }
  if (value.length !== PARTNER_LEN) {
    throw new IntentCoreError("ExtMalformed");
  }
  const key = value.subarray(0, 32);
  const bps = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(32, true);
  if (key.every((b) => b === 0) || bps === 0) {
    throw new IntentCoreError("ExtMalformed");
  }
  if (bps > MAX_PARTNER_BPS) {
    throw new IntentCoreError("PartnerFeeTooHigh");
  }
  return { key: getAddressDecoder().decode(key), bps };
}
