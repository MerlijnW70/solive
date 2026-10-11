import { type Address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeLookupTable, LOOKUP_TABLE_HEADER } from "../src/index.js";

const A = "11111111111111111111111111111112" as Address;
const B = "SysvarC1ock11111111111111111111111111111111" as Address;

function table(tag: number, addresses: Address[], extra = 0): Uint8Array {
  const out = new Uint8Array(LOOKUP_TABLE_HEADER + addresses.length * 32 + extra);
  new DataView(out.buffer).setUint32(0, tag, true);
  addresses.forEach((a, i) => out.set(getAddressEncoder().encode(a), LOOKUP_TABLE_HEADER + i * 32));
  return out;
}

describe("lookup tables", () => {
  it("reads every address after the header", () => {
    expect(LOOKUP_TABLE_HEADER).toBe(56);
    expect(decodeLookupTable(table(1, [A, B]))).toEqual([A, B]);
    expect(decodeLookupTable(table(1, []))).toEqual([]);
  });

  it("refuses an account that is not a whole lookup table", () => {
    expect(() => decodeLookupTable(table(0, [A]))).toThrow("account is not a lookup table (tag 0)");
    expect(() => decodeLookupTable(table(2, [A]))).toThrow("account is not a lookup table (tag 2)");
    expect(() => decodeLookupTable(table(1, [A], 1))).toThrow(`a lookup table of ${LOOKUP_TABLE_HEADER + 33} bytes is malformed`);
    expect(() => decodeLookupTable(new Uint8Array(55))).toThrow("a lookup table of 55 bytes is malformed");
  });
});
