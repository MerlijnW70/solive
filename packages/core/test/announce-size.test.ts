import { describe, expect, it } from "vitest";
import { type AnnounceShape, announceWireSize, delivery, maxSealedUrl, PACKET_DATA_SIZE } from "../src/index.js";
import { InvalidInput } from "../src/errors.js";

const light = (committee: boolean, version: AnnounceShape["version"] = "legacy"): AnnounceShape => ({
  recipients: committee ? 8 : 1,
  committee,
  relayer: false,
  board: false,
  claimList: false,
  feeTo: false,
  priorityFee: true,
  version,
});

const heavy = (committee: boolean, version: AnnounceShape["version"] = "legacy"): AnnounceShape => ({
  ...light(committee, version),
  relayer: true,
  board: true,
  claimList: true,
  feeTo: true,
});

describe("the longest sealed url an announce transaction carries", () => {
  it("agrees with the Rust oracle for a worker announcing to a judge or a committee of 8", () => {
    expect(delivery.MAX_BLOB_URL).toBe(200);
    for (const committee of [false, true]) {
      expect(announceWireSize(light(committee), delivery.MAX_BLOB_URL)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      expect(maxSealedUrl(light(committee))).toBe(200);
    }
    expect(maxSealedUrl(heavy(false))).toBe(200);
  });

  it("agrees with the Rust oracle that a relayed committee announcement with claims and a fee stops at 116", () => {
    const shape = heavy(true);
    expect(maxSealedUrl(shape)).toBe(116);
    expect(announceWireSize(shape, 116)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(announceWireSize(shape, 117)).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it("agrees with the Rust oracle that a v0 transaction, which clients send, is 2 bytes larger and stops at 114", () => {
    for (const committee of [false, true]) {
      for (const make of [light, heavy]) {
        expect(announceWireSize(make(committee, 0), 40)).toBe(announceWireSize(make(committee), 40) + 2);
      }
    }
    expect(maxSealedUrl(heavy(true, 0))).toBe(114);
    expect(announceWireSize(heavy(true, 0), 114)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(announceWireSize(heavy(true, 0), 115)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(maxSealedUrl(light(true, 0))).toBe(200);
    expect(maxSealedUrl(heavy(false, 0))).toBe(200);
  });

  it("grows by the bytes of each url byte, account, signer and instruction", () => {
    const base = light(true);
    const at = (shape: AnnounceShape, url = 50) => announceWireSize(shape, url);
    expect(at(base, 51) - at(base)).toBe(1);
    expect(at({ ...base, board: true }) - at(base)).toBe(32);
    expect(at({ ...base, claimList: true }) - at(base)).toBe(32);
    expect(at({ ...base, feeTo: true }) - at(base)).toBe(32);
    expect(at({ ...base, relayer: true }) - at(base)).toBe(64 + 32);
    expect(at(light(false)) - at({ ...light(false), recipients: 1, committee: true })).toBe(32);
    expect(at({ ...base, recipients: 7 }) - at(base)).toBe(-40);
    expect(at(base) - at({ ...base, priorityFee: false })).toBe(32 + 2 * (1 + 1 + 1) + 5 + 9);
  });

  it("refuses shapes the program refuses", () => {
    expect(() => maxSealedUrl({ ...light(true), recipients: 0 })).toThrow(InvalidInput);
    expect(() => maxSealedUrl({ ...light(true), recipients: 9 })).toThrow(InvalidInput);
    expect(() => maxSealedUrl({ ...light(false), recipients: 2 })).toThrow(InvalidInput);
    expect(() => maxSealedUrl({ ...light(true), recipients: 1.5 })).toThrow(InvalidInput);
  });
});
