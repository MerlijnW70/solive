import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { hostAddresses, ipFamily, privateAddress } from "../src/address-ranges.js";
import { base64Bytes, bytesBase64, bytesHex, hexBytes, joinedBytes, sha256Hex } from "../src/encoding.js";
import { shown } from "../src/shown.js";

const ADDRESSES = [
  "1.2.3.4",
  "255.255.255.255",
  "01.2.3.4",
  "1.2.3",
  "256.1.1.1",
  "::",
  "::1",
  "fe80::1",
  "fe80::1%eth0",
  "fe80::1%",
  "::ffff:10.0.0.1",
  "2001:db8::1",
  "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
  "1:2:3:4:5:6:7:8:9",
  "gggg::1",
  "example.org",
  "",
  "[::1]",
];

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function randomBytes(count: number): Uint8Array[] {
  const next = seeded(7);
  return Array.from({ length: count }, () => Uint8Array.from({ length: Math.floor(next() * 97) }, () => Math.floor(next() * 256)));
}

function randomAddresses(count: number): string[] {
  const next = seeded(11);
  const pick = (choices: string) => choices[Math.floor(next() * choices.length)] ?? "";
  return Array.from({ length: count }, () => Array.from({ length: 1 + Math.floor(next() * 24) }, () => pick("0123456789abcdefABCDEF.:%[]x")).join(""));
}

describe("the web helpers behind the client root", () => {
  it("shows an RPC error the way util.inspect prints it on one line", () => {
    for (const value of [{ InstructionError: [0, { Custom: 6008 }] }, { InstructionError: [1, "InvalidAccountData"] }, "AccountInUse", null, { Custom: 16n }, { "odd key": [] }, {}]) {
      expect(shown(value)).toBe(inspect(value, { depth: null, breakLength: Infinity }));
    }
  });

  it("names the family of an address as node:net does", () => {
    for (const text of ADDRESSES) {
      expect([text, ipFamily(text)]).toEqual([text, isIP(text)]);
    }
    for (const text of randomAddresses(2_000)) {
      expect([text, ipFamily(text)]).toEqual([text, isIP(text)]);
    }
  });

  it("checks a host written as an address without a lookup and leaves a name unchecked", async () => {
    expect(await hostAddresses("93.184.215.14", null)).toEqual(["93.184.215.14"]);
    expect(await hostAddresses("[2606:2800:21f:cb07::1]", null)).toEqual(["2606:2800:21f:cb07::1"]);
    for (const host of ["10.0.0.1", "[fd00::1]", "127.0.0.1", "localhost", "a.localhost", "LOCALHOST."]) {
      expect([host, await hostAddresses(host, null)]).toEqual([host, null]);
    }
    expect(await hostAddresses("127.0.0.1", null, true)).toEqual(["127.0.0.1"]);
    expect(await hostAddresses("localhost", null, true)).toBeUndefined();
    expect(await hostAddresses("spec.example", null)).toBeUndefined();
    expect(await hostAddresses("spec.example", async () => ["10.0.0.1"])).toBeNull();
    expect(await hostAddresses("spec.example", async () => ["93.184.215.14"])).toEqual(["93.184.215.14"]);
    expect(privateAddress("fe80::1%eth0")).toBe(true);
  });

  it("encodes hex and base64 as Buffer does, and hashes with web crypto as node:crypto does", async () => {
    for (const bytes of randomBytes(200)) {
      const buffer = Buffer.from(bytes);
      expect(bytesHex(bytes)).toBe(buffer.toString("hex"));
      expect(hexBytes(buffer.toString("hex"))).toEqual(new Uint8Array(bytes));
      expect(bytesBase64(bytes)).toBe(buffer.toString("base64"));
      expect(base64Bytes(buffer.toString("base64"))).toEqual(new Uint8Array(bytes));
      expect(joinedBytes([bytes, bytes])).toEqual(new Uint8Array(Buffer.concat([buffer, buffer])));
      expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(() => hexBytes("abc")).toThrow("hex text must be an even run of hex digits");
    expect(() => hexBytes("zz")).toThrow("hex text must be an even run of hex digits");
  });
});
