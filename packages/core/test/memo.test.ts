import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_MEMO_PREFIX,
  deliveryMemo,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isMemoUrl,
  MAX_DELIVERY_MEMO,
  MAX_MEMO_URL,
  parseDeliveryMemo,
  parseReleaseMemo,
  parseSpecMemo,
  PRODUCT_SLUG,
  RELEASE_MEMO_PREFIX,
  releaseMemo,
  SPEC_MEMO_PREFIX,
  specMemo,
} from "../src/index.js";

const URL_OK = "https://example.org/spec.md";
const HASH = "ab".repeat(32);
const INTENT = INTENT_ENGINE_PROGRAM_ADDRESS;
const delivery = { intent: INTENT, sha256: HASH, url: URL_OK };

describe("spec and delivery memos", () => {
  it("name the product in their prefixes and round-trip", () => {
    expect(SPEC_MEMO_PREFIX).toBe(`${PRODUCT_SLUG}-spec:`);
    expect(DELIVERY_MEMO_PREFIX).toBe(`${PRODUCT_SLUG}-delivery:`);
    expect(specMemo(URL_OK)).toBe(`${PRODUCT_SLUG}-spec:${URL_OK}`);
    expect(parseSpecMemo(specMemo(URL_OK))).toEqual({ url: URL_OK });
    expect(deliveryMemo(delivery)).toBe(`${PRODUCT_SLUG}-delivery:${INTENT}:${HASH}:${URL_OK}`);
    expect(parseDeliveryMemo(deliveryMemo(delivery))).toEqual(delivery);
    const local = "http://127.0.0.1:8080/a:b?c=d#e";
    expect(parseDeliveryMemo(deliveryMemo({ ...delivery, url: local }))).toEqual({ ...delivery, url: local });
  });

  it("accept https anywhere and http only on localhost, printable, without spaces or credentials, at most the limit", () => {
    for (const url of [URL_OK, "http://localhost/x", "http://127.0.0.1:3000/x", "http://[::1]/x", "https://a.io/" + "x".repeat(MAX_MEMO_URL - 13)]) {
      expect(isMemoUrl(url), url).toBe(true);
    }
    for (const url of [
      "",
      "not a url",
      "http://example.org/spec.md",
      "http://localhost.example.org/x",
      "ftp://example.org/x",
      "https:example.org/x",
      "https://",
      "https://user:pass@example.org/x",
      "https://example.org/has space",
      "https://example.org/" + String.fromCharCode(0xe9),
      "https://example.org/\n",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://a.io/" + "x".repeat(MAX_MEMO_URL - 12),
    ]) {
      expect(isMemoUrl(url), url).toBe(false);
      expect(() => specMemo(url)).toThrow(RangeError);
      expect(() => deliveryMemo({ ...delivery, url })).toThrow(RangeError);
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toBeNull();
      expect(parseDeliveryMemo(`${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}:${url}`)).toBeNull();
    }
  });

  it("refuse to build a delivery with a bad intent or sha256", () => {
    for (const sha256 of ["", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33), `${"ab".repeat(31)}zz`]) {
      expect(() => deliveryMemo({ ...delivery, sha256 })).toThrow(RangeError);
    }
    for (const intent of ["", "x", "0OIl".repeat(11), `${INTENT}1`]) {
      expect(() => deliveryMemo({ ...delivery, intent: intent as typeof INTENT })).toThrow(RangeError);
    }
  });

  it("parse nothing malformed, including the release receipt memo and each other's memos", () => {
    for (const text of [
      "",
      SPEC_MEMO_PREFIX,
      DELIVERY_MEMO_PREFIX,
      `delivery sha256:${HASH}`,
      `${DELIVERY_MEMO_PREFIX}x:y:z`,
      `${SPEC_MEMO_PREFIX}has space`,
      ` ${specMemo(URL_OK)}`,
      `${specMemo(URL_OK)} `,
      specMemo(URL_OK).toUpperCase(),
      `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH.toUpperCase()}:${URL_OK}`,
      `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}${URL_OK}`,
      `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}:`,
      `${DELIVERY_MEMO_PREFIX}${INTENT}${HASH}:${URL_OK}`,
      `${DELIVERY_MEMO_PREFIX}:${HASH}:${URL_OK}`,
      `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}:${URL_OK}\n`,
      `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}:${URL_OK}${"x".repeat(MAX_DELIVERY_MEMO)}`,
      `${SPEC_MEMO_PREFIX}${URL_OK}${"x".repeat(MAX_MEMO_URL)}`,
    ]) {
      expect(parseSpecMemo(text), text).toBeNull();
      expect(parseDeliveryMemo(text), text).toBeNull();
    }
    expect(parseSpecMemo(deliveryMemo(delivery))).toBeNull();
    expect(parseDeliveryMemo(specMemo(URL_OK))).toBeNull();
  });

  it("return null or a memo that rebuilds to the same text for any input, and never throw", () => {
    const tail = fc.oneof(fc.string({ unit: "binary", maxLength: 300 }), fc.string({ maxLength: 300 }).map((s) => `${URL_OK}${s}`));
    fc.assert(
      fc.property(fc.oneof(tail, tail.map((s) => `${SPEC_MEMO_PREFIX}${s}`)), (text) => {
        const parsed = parseSpecMemo(text);
        expect(parsed === null || specMemo(parsed.url) === text).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.oneof(tail, tail.map((s) => `${DELIVERY_MEMO_PREFIX}${INTENT}:${HASH}:${s}`), tail.map((s) => `${DELIVERY_MEMO_PREFIX}${s}`)), (text) => {
        const parsed = parseDeliveryMemo(text);
        expect(parsed === null || deliveryMemo(parsed) === text).toBe(true);
        expect(parsed === null || text.length <= MAX_DELIVERY_MEMO).toBe(true);
      }),
    );
  });

  it("record a release's delivered sha256 as the exact text the wallet release writes, and read nothing else", () => {
    expect(RELEASE_MEMO_PREFIX).toBe("delivery sha256:");
    expect(releaseMemo(HASH)).toBe(`delivery sha256:${HASH}`);
    expect(parseReleaseMemo(releaseMemo(HASH))).toBe(HASH);
    expect(() => releaseMemo(HASH.toUpperCase())).toThrow(RangeError);
    for (const text of [`delivery sha256:${HASH.toUpperCase()}`, `delivery sha256:${HASH} `, `delivery sha256:${HASH.slice(1)}`, deliveryMemo(delivery), ""]) {
      expect(parseReleaseMemo(text), text).toBeNull();
    }
  });
});
