import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "@intent-engine/core";
import { createClient } from "../src/index.js";
import { sha256Bytes } from "../src/announce.js";
import { intentAddress } from "../src/intent-ref.js";
import { isReadFailure } from "../src/read-failure.js";
import { CLUSTER_NAMES, CLUSTER_URLS, clusterUrl, urlOfClusterName } from "../src/simple.js";
import { sha256Given } from "../src/simple-reads.js";
import { specHashBytes } from "../src/simple-tokens.js";

const LOCAL = "http://127.0.0.1:8899";
const HASH = "ab".repeat(32);

describe("watch options", () => {
  it("refuses a poll or resync that is not a positive finite number", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, 10n]) {
      expect(() => createClient({ url: LOCAL, pollMs: bad as number })).toThrow(InvalidInput);
      expect(() => createClient({ url: LOCAL, resyncSeconds: bad as number })).toThrow(InvalidInput);
    }
    expect(() => createClient({ url: LOCAL, pollMs: 0 })).toThrow("pollMs must be a positive finite number, not 0");
    expect(() => createClient({ url: LOCAL, pollMs: 50, resyncSeconds: 0.5 })).not.toThrow();
  });
});

describe("intent references", () => {
  it("refuses a nonce above the u64 maximum", async () => {
    const owner = (await generateKeyPairSigner()).address;
    await expect(intentAddress({ owner, nonce: 2n ** 64n })).rejects.toBeInstanceOf(InvalidInput);
    await expect(intentAddress({ owner, nonce: 2n ** 64n - 1n })).resolves.toBeTypeOf("string");
  });
});

describe("one spec hash parser", () => {
  it("reads one hash the same way everywhere", () => {
    const forms = [HASH, HASH.toUpperCase(), ` ${HASH.toUpperCase()}\n`];
    const bytes = specHashBytes(HASH);
    for (const form of forms) {
      expect(specHashBytes(form)).toStrictEqual(bytes);
      expect(sha256Bytes(form)).toStrictEqual(bytes);
      expect(sha256Given(form, "sha256")).toBe(HASH);
    }
  });

  it("refuses the same bad texts everywhere, naming the field", () => {
    for (const bad of ["", HASH.slice(1), `${HASH}0`, `${HASH.slice(1)}g`, 5 as unknown as string]) {
      expect(() => specHashBytes(bad)).toThrow(InvalidInput);
      expect(() => sha256Bytes(bad)).toThrow(InvalidInput);
      expect(() => sha256Given(bad, "delivered")).toThrow("delivered must be a sha256 as 64 hex digits");
    }
  });
});

describe("one cluster table", () => {
  it("names a cluster the same through its aliases", () => {
    expect(urlOfClusterName("mainnet-beta")).toBe(CLUSTER_URLS.mainnet);
    expect(urlOfClusterName("mainnet")).toBe(CLUSTER_URLS.mainnet);
    expect(clusterUrl({ cluster: "mainnet-beta" as never })).toBe(CLUSTER_URLS.mainnet);
    expect(Object.keys(CLUSTER_NAMES)).toContain("mainnet-beta");
  });

  it("refuses an unknown name, including names an object inherits", () => {
    for (const bad of ["nope", "toString", "__proto__", "constructor", "", "DEVNET"]) {
      expect(() => urlOfClusterName(bad)).toThrow(InvalidInput);
      expect(() => clusterUrl({ cluster: bad as never })).toThrow(InvalidInput);
    }
  });
});

describe("read failure classes", () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });

  it("reads TLS and certificate failures as read failures, at any depth", () => {
    for (const code of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]) {
      expect(isReadFailure(coded(code))).toBe(true);
      expect(isReadFailure(new TypeError("fetch failed", { cause: coded(code) }))).toBe(true);
    }
  });

  it("reads a non-JSON reply and a fetch failure without a code as read failures", () => {
    expect(isReadFailure(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"))).toBe(true);
    expect(isReadFailure(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    for (const message of ["JSON Parse error: Unrecognized token '<'", "The string did not match the expected pattern.", "JSON.parse: unexpected character at line 1 column 1 of the JSON data", "Expected property name or '}' in JSON at position 1", "Unexpected non-whitespace character after JSON at position 2"]) {
      expect(isReadFailure(new SyntaxError(message))).toBe(true);
    }
    for (const message of ["fetch failed", "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(isReadFailure(new TypeError(message))).toBe(true);
    }
  });

  it("leaves programming errors alone", () => {
    expect(isReadFailure(new TypeError("Cannot read properties of undefined (reading 'slot')"))).toBe(false);
    expect(isReadFailure(new SyntaxError("Unexpected identifier 'x'"))).toBe(false);
    for (const message of ["Unexpected token '}'", "Unexpected token ')'", "Invalid or unexpected token", "Unexpected end of input", "Unexpected token 'JSON'"]) {
      expect(isReadFailure(new SyntaxError(message))).toBe(false);
    }
    for (const code of ["ERR_OSSL_EVP_UNSUPPORTED", "ERR_TLS_INVALID_PROTOCOL_VERSION", "ERR_TLS_PROTOCOL_VERSION_CONFLICT", "ERR_TLS_INVALID_STATE"]) {
      expect(isReadFailure(coded(code))).toBe(false);
    }
    expect(isReadFailure(new RangeError("Invalid array length"))).toBe(false);
    expect(isReadFailure(coded("ERR_INVALID_ARG_TYPE"))).toBe(false);
    expect(isReadFailure(coded("CERTAINLY"))).toBe(false);
    expect(isReadFailure("fetch failed")).toBe(false);
  });
});
