import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isLegacyMemoUrl,
  isMemoUrl,
  MAX_MEMO_URL,
  MEMO_URL_RULE,
  parseRelease,
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

describe("spec and release memos", () => {
  it("name the product in their prefixes and round-trip", () => {
    expect(SPEC_MEMO_PREFIX).toBe(`${PRODUCT_SLUG}-spec:`);
    expect(specMemo(URL_OK)).toBe(`${PRODUCT_SLUG}-spec:${URL_OK}`);
    expect(parseSpecMemo(specMemo(URL_OK))).toEqual({ url: URL_OK });
    const local = "http://127.0.0.1:8080/a:b?c=d#e";
    expect(parseSpecMemo(specMemo(local))).toEqual({ url: local });
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
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toBeNull();
    }
  });

  it("memo urls refuse backslashes and non canonical forms", () => {
    for (const url of [
      "https://a.example/spec.md",
      "https://a.example",
      "https://a.example/",
      "https://a.example/a?b=c#d",
      "http://localhost:8080/s",
      "http://localhost",
      "http://127.0.0.1/x",
      "http://[::1]:9/x",
    ]) {
      expect(isMemoUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://evil.example\\@good.example/",
      "https://a.example\\b",
      "http://127.1/",
      "http://0x7f.0.0.1/",
      "http://2130706433/",
      "http://LOCALHOST/x",
      "http://localhost./x",
      "http://[0:0:0:0:0:0:0:1]/x",
      "https://A.example/x",
      "https://a.example/./b",
      "https://a.example/a/../b",
      "https://a.example:443/x",
      "HTTPS://a.example/x",
      "https://a.example?x",
      "https:/a.example/x",
    ]) {
      expect(isMemoUrl(url), url).toBe(false);
      expect(() => specMemo(url)).toThrow(RangeError);
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toEqual(isLegacyMemoUrl(url) ? { url } : null);
    }
  });

  it("writing still refuses a non canonical memo url", () => {
    for (const url of ["https://Example.com/w.tar", "https://host:443/w.tar", "https://a.example/a/../b", "https://a.example/./b", "https://a.example?x", "http://LOCALHOST/x"]) {
      expect(isMemoUrl(url), url).toBe(false);
      expect(isLegacyMemoUrl(url), url).toBe(true);
      expect(() => specMemo(url)).toThrow(`a spec url must be ${MEMO_URL_RULE}`);
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toEqual({ url });
    }
    for (const url of ["http://example.org/x", "HTTPS://a.example/x", "https:/a.example/x", "https://user:pass@example.org/x", "https://example.org/has space", "https://a.io/" + "x".repeat(MAX_MEMO_URL - 12)]) {
      expect(isLegacyMemoUrl(url), url).toBe(false);
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toBeNull();
    }
    for (const url of [URL_OK, "http://127.0.0.1:8080/a:b?c=d#e", "https://a.example"]) {
      expect(isMemoUrl(url), url).toBe(true);
      expect(isLegacyMemoUrl(url), url).toBe(true);
    }
  });

  it("reading refuses a backslash url", () => {
    for (const url of ["https://trusted.org\\@evil.com/x", "https://evil.example\\@good.example/", "https://a.example\\b", "https://a.example/x\\y", "http://localhost\\@evil.com/"]) {
      expect(isLegacyMemoUrl(url), url).toBe(false);
      expect(isMemoUrl(url), url).toBe(false);
      expect(parseSpecMemo(`${SPEC_MEMO_PREFIX}${url}`)).toBeNull();
    }
  });

  it("the memo url rule names what canonical means", () => {
    const cases: [string, string][] = [
      ["lowercase scheme and host", "HTTPS://A.example/x"],
      ["no default port", "https://a.example:443/x"],
      ["no . or .. path segments", "https://a.example/a/./b/../c"],
      ["a / path before any ? or #", "https://a.example?x"],
      ["characters percent-encoded as new URL() would", "https://a.example/a\"b<c>{d}"],
    ];
    for (const [phrase, url] of cases) {
      expect(MEMO_URL_RULE).toContain(phrase);
      expect(isMemoUrl(url), url).toBe(false);
      const canonical = new URL(url).href;
      expect(canonical).not.toBe(url);
      expect(isMemoUrl(canonical), canonical).toBe(true);
      expect(() => specMemo(url)).toThrow(`a spec url must be ${MEMO_URL_RULE}`);
    }
    expect(MEMO_URL_RULE).toContain(`at most ${MAX_MEMO_URL} printable characters without spaces or backslashes`);
    expect(MEMO_URL_RULE).toContain("http on localhost, 127.0.0.1 or [::1]");
  });

  it("parse nothing malformed, including the release receipt memo", () => {
    for (const text of [
      "",
      SPEC_MEMO_PREFIX,
      `delivery sha256:${HASH}`,
      `${SPEC_MEMO_PREFIX}has space`,
      ` ${specMemo(URL_OK)}`,
      `${specMemo(URL_OK)} `,
      specMemo(URL_OK).toUpperCase(),
      `${SPEC_MEMO_PREFIX}${URL_OK}${"x".repeat(MAX_MEMO_URL)}`,
    ]) {
      expect(parseSpecMemo(text), text).toBeNull();
    }
  });

  it("return null or a memo that rebuilds to the same text for any input, and never throw", () => {
    const tail = fc.oneof(fc.string({ unit: "binary", maxLength: 300 }), fc.string({ maxLength: 300 }).map((s) => `${URL_OK}${s}`));
    fc.assert(
      fc.property(fc.oneof(tail, tail.map((s) => `${SPEC_MEMO_PREFIX}${s}`)), (text) => {
        const parsed = parseSpecMemo(text);
        expect(parsed === null || `${SPEC_MEMO_PREFIX}${parsed.url}` === text).toBe(true);
        expect(parsed === null || !isMemoUrl(parsed.url) || specMemo(parsed.url) === text).toBe(true);
      }),
    );
  });

  it("record a release's delivered sha256 as the exact text the wallet release writes, and read nothing else", () => {
    expect(RELEASE_MEMO_PREFIX).toBe("delivery sha256:");
    expect(releaseMemo(HASH)).toBe(`delivery sha256:${HASH}`);
    expect(parseReleaseMemo(releaseMemo(HASH))).toBe(HASH);
    expect(() => releaseMemo(HASH.toUpperCase())).toThrow(RangeError);
    for (const text of [`delivery sha256:${HASH.toUpperCase()}`, `delivery sha256:${HASH} `, `delivery sha256:${HASH.slice(1)}`, specMemo(URL_OK), ""]) {
      expect(parseReleaseMemo(text), text).toBeNull();
    }
  });

  it("record the payee's salt beside the work's hash and still read as that hash", () => {
    const salt = "ab".repeat(16);
    const memo = releaseMemo(HASH, salt);
    expect(memo).toBe(`delivery sha256:${HASH} salt:${salt}`);
    expect(parseRelease(memo)).toEqual({ sha256: HASH, salt });
    expect(parseReleaseMemo(memo)).toBe(HASH);
    expect(parseRelease(releaseMemo(HASH))).toEqual({ sha256: HASH });
    expect(parseRelease(`${memo} salt:${salt}`)).toBeNull();
    expect(parseRelease(`delivery sha256:${HASH} salt:ab`)).toBeNull();
    expect(() => releaseMemo(HASH, "ab")).toThrow(RangeError);
  });
});
