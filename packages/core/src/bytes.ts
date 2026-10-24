import { type Address, getAddressEncoder } from "@solana/kit";
import { I64_MAX, I64_MIN } from "./kinds.js";
import { U64_MAX } from "./math.js";

export const ascii = (s: string) => new TextEncoder().encode(s);

export const key = (a: Address) => getAddressEncoder().encode(a);

export function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) {
    throw new RangeError(`${v} is outside u64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function i64le(v: bigint): Uint8Array {
  if (v < I64_MIN || v > I64_MAX) {
    throw new RangeError(`${v} is outside i64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
}

export function u32le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new RangeError(`${v} is outside u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
}

export function u16le(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new RangeError(`${v} is outside u16`);
  }
  return Uint8Array.of(v & 0xff, v >> 8);
}

export function concat(parts: ArrayLike<number>[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (at !== length) {
    throw new RangeError(`expected ${length} bytes, built ${at}`);
  }
  return out;
}

export function sized(name: string, bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length !== length) {
    throw new RangeError(`${name} must be ${length} bytes`);
  }
  return bytes;
}

export function compareKeys(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Array.from(b, (byte, i) => (a[i] ?? 0) - byte).find((d) => d !== 0) ?? 0;
}
