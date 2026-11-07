import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "@intent-engine/core";
import { cidOfSpecHash, specHashOfCid } from "../src/index.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const cids = JSON.parse(readFileSync(new URL("./demo-spec-cids.json", import.meta.url), "utf8")) as Record<string, string>;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function encoded(bytes: readonly number[]): string {
  const bits = bytes.map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  return "b" + Array.from({ length: padded.length / 5 }, (_, i) => ALPHABET[Number.parseInt(padded.slice(5 * i, 5 * i + 5), 2)]).join("");
}

const digest = (hex: string): number[] => [...Buffer.from(hex, "hex")];

describe("the CID of a spec hash", () => {
  const hello = sha("hello world");

  it("is the CIDv1 raw sha2-256 that IPFS gives the bytes", () => {
    expect(cidOfSpecHash(hello)).toBe("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
    expect(cidOfSpecHash(hello)).toBe(encoded([0x01, 0x55, 0x12, 0x20, ...digest(hello)]));
  });

  it("of each demo spec matches the fixture", () => {
    const found = Object.fromEntries(Object.keys(cids).map((name) => [name, cidOfSpecHash(sha(readFileSync(join(ROOT, "examples", "demo", name, "SPEC.md"))))]));
    expect(found).toStrictEqual(cids);
    expect(Object.keys(cids)).toHaveLength(3);
  });

  it("gives the same CID for uppercase and padded hashes", () => {
    expect(cidOfSpecHash(hello.toUpperCase())).toBe(cidOfSpecHash(hello));
    expect(cidOfSpecHash(`  ${hello}\n`)).toBe(cidOfSpecHash(hello));
  });

  it("refuses a text that is not 64 hex digits", () => {
    for (const bad of ["", hello.slice(1), `${hello}00`, `${hello.slice(1)}g`]) {
      expect(() => cidOfSpecHash(bad)).toThrow(InvalidInput);
    }
  });
});

describe("the spec hash of a CID", () => {
  const hash = sha("a spec");
  const cid = cidOfSpecHash(hash);

  it("gives back the hash of a CIDv1 raw sha2-256", () => {
    expect(specHashOfCid(cid)).toBe(hash);
    expect(specHashOfCid("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e")).toBe(sha("hello world"));
  });

  it("refuses another version, codec or hash", () => {
    expect(specHashOfCid(encoded([0x02, 0x55, 0x12, 0x20, ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x00, 0x55, 0x12, 0x20, ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x70, 0x12, 0x20, ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x71, 0x12, 0x20, ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x55, 0x13, 0x40, ...digest(hash), ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x55, 0x1e, 0x20, ...digest(hash)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x55, 0x12, 0x10, ...digest(hash).slice(0, 16)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x55, 0x12, 0x20, ...digest(hash).slice(0, 31)]))).toBeNull();
    expect(specHashOfCid(encoded([0x01, 0x55, 0x12, 0x20, ...digest(hash), 0x00]))).toBeNull();
  });

  it("refuses a CIDv0, another base and a text that is not the one canonical spelling", () => {
    expect(specHashOfCid("QmWATWQ7fVPP2EFGu71UkfnqhYXDYH566qy47CnJDgvs8u")).toBeNull();
    expect(specHashOfCid(cid.toUpperCase())).toBeNull();
    expect(specHashOfCid(`B${cid.slice(1)}`)).toBeNull();
    expect(specHashOfCid(`z${cid.slice(1)}`)).toBeNull();
    expect(specHashOfCid("b")).toBeNull();
    expect(specHashOfCid("")).toBeNull();
    expect(specHashOfCid(`${cid}a`)).toBeNull();
    const last = ALPHABET.indexOf(cid.at(-1) ?? "");
    expect(last & 3).toBe(0);
    expect(specHashOfCid(cid.slice(0, -1) + ALPHABET[last | 1])).toBeNull();
  });
});
