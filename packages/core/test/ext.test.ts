import { describe, expect, it } from "vitest";
import { IntentCoreError } from "../src/index.js";
import {
  checkFlags,
  encodePartner,
  MAX_PARTNER_BPS,
  PARTNER_LEN,
  PARTNER_TAG,
  partnerOf,
  encodeExt,
  EXT_MAX_LEN,
  findExt,
  KNOWN_FLAGS,
  validateExt,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";

describe("extension fields", () => {
  it("encode tag, little-endian length and value in strictly rising tag order", () => {
    const ext = encodeExt([
      { tag: 1, value: new Uint8Array([9]) },
      { tag: 7, value: new Uint8Array(258) },
    ]);
    expect(Array.from(ext.subarray(0, 7))).toEqual([1, 1, 0, 9, 7, 2, 1]);
    expect(ext).toHaveLength(4 + 3 + 258);
    expect(() => validateExt(ext, [1, 7])).not.toThrow();
    expect(Array.from(findExt(ext, 1) ?? [])).toEqual([9]);
    expect(findExt(ext, 7)).toHaveLength(258);
    expect(findExt(ext, 2)).toBeUndefined();
    expect(encodeExt([])).toHaveLength(0);
  });

  it("refuse tags out of order, out of range or too long", () => {
    const v = new Uint8Array();
    expect(() => encodeExt([{ tag: 0, value: v }])).toThrow(InvalidInput);
    expect(() => encodeExt([{ tag: 256, value: v }])).toThrow(InvalidInput);
    expect(() => encodeExt([{ tag: 1.5, value: v }])).toThrow(InvalidInput);
    expect(() => encodeExt([{ tag: 2, value: v }, { tag: 2, value: v }])).toThrow(
      "extension tags must rise strictly within 1..255, got 2 after 2",
    );
    expect(() => encodeExt([{ tag: 3, value: v }, { tag: 2, value: v }])).toThrow(InvalidInput);
    expect(encodeExt([{ tag: 255, value: v }])).toEqual(new Uint8Array([255, 0, 0]));
    expect(() => encodeExt([{ tag: 1, value: new Uint8Array(0x10000) }])).toThrow(
      new IntentCoreError("ExtTooLong"),
    );
    expect(encodeExt([{ tag: 1, value: new Uint8Array(EXT_MAX_LEN - 3) }])).toHaveLength(EXT_MAX_LEN);
    expect(() => encodeExt([{ tag: 1, value: new Uint8Array(EXT_MAX_LEN - 2) }])).toThrow(
      new IntentCoreError("ExtTooLong"),
    );
  });

  it("read past a truncated field as malformed", () => {
    expect(() => findExt(new Uint8Array([1, 2, 0, 9]), 1)).toThrow(new IntentCoreError("ExtMalformed"));
    expect(() => findExt(new Uint8Array([1, 0]), 1)).toThrow(new IntentCoreError("ExtMalformed"));
    expect(findExt(new Uint8Array([1, 0, 0]), 1)).toHaveLength(0);
  });

  it("accept no flags in this version", () => {
    expect(KNOWN_FLAGS).toBe(0);
    expect(checkFlags(0)).toBe(0);
    for (const flags of [1, 0x8000, 0xffff]) {
      expect(() => checkFlags(flags)).toThrow(new IntentCoreError("FlagsUnknown"));
    }
    for (const flags of [-1, 0x10000, 0.5]) {
      expect(() => checkFlags(flags)).toThrow(InvalidInput);
    }
  });
});

describe("partner extension", () => {
  const key = "11111111111111111111111111111112" as Parameters<typeof encodePartner>[0]["key"];

  it("round-trips a partner and its share through the tag the program reads", () => {
    expect([PARTNER_TAG, PARTNER_LEN, MAX_PARTNER_BPS]).toEqual([1, 34, 100]);
    for (const bps of [1, 50, MAX_PARTNER_BPS]) {
      const ext = encodePartner({ key, bps });
      expect(ext).toHaveLength(3 + PARTNER_LEN);
      expect(Array.from(ext.subarray(0, 3))).toEqual([1, 34, 0]);
      expect(partnerOf(ext)).toEqual({ key, bps });
    }
    expect(partnerOf(new Uint8Array())).toBeUndefined();
  });

  it("refuses a share outside 1 to the cap", () => {
    for (const bps of [0, MAX_PARTNER_BPS + 1, 1.5, -1]) {
      expect(() => encodePartner({ key, bps })).toThrow(
        `a partner share must be 1 to ${MAX_PARTNER_BPS} bps, got ${bps}`,
      );
    }
  });
});
