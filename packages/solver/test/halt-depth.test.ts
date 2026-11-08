import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { haltOf, NODE_RATE_LIMITED, nodeRateLimited } from "../src/index.js";

const httpError = (statusCode: number): Error =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { message: "Too Many Requests", statusCode, headers: new Headers() });

const textError = (): Error => new Error("HTTP error (429): Too Many Requests");

const plain = (index: number): Error => new Error(`link ${index} failed`);

const chainWithSignalAt = (signal: Error, position: number, length: number): Error => {
  let cause: Error | undefined;
  for (let index = length; index >= 1; index--) {
    cause = index === position ? signal : new Error(`link ${index} failed`, cause ? { cause } : undefined);
  }
  return cause as Error;
};

const signals: [string, () => Error][] = [
  ["an http 429", () => httpError(429)],
  ["a 429 in the message", textError],
];

describe.each(signals)("the cause depth bound is the literal 8 links, counting the error itself, for %s", (_, make) => {
  it("detects the signal at link 8", () => {
    const error = chainWithSignalAt(make(), 8, 12);
    expect(nodeRateLimited(error)).toBe(true);
    expect(haltOf(error)).toBe(NODE_RATE_LIMITED);
  });

  it("detects the signal at link 1", () => {
    expect(nodeRateLimited(chainWithSignalAt(make(), 1, 12))).toBe(true);
  });

  it("does not detect a signal that appears only at link 9", () => {
    const error = chainWithSignalAt(make(), 9, 12);
    expect(nodeRateLimited(error)).toBe(false);
    expect(haltOf(error)).toBeNull();
  });

  it("does not detect a signal at link 9 of a chain that ends there", () => {
    const error = chainWithSignalAt(make(), 9, 9);
    expect(nodeRateLimited(error)).toBe(false);
    expect(haltOf(error)).toBeNull();
  });

  it("detects the signal at link 7 of a short chain", () => {
    expect(nodeRateLimited(chainWithSignalAt(make(), 7, 7))).toBe(true);
  });
});

describe("a cyclic cause chain", () => {
  it("terminates and reports no rate limit", () => {
    const a = plain(1);
    const b = plain(2);
    a.cause = b;
    b.cause = a;
    expect(nodeRateLimited(a)).toBe(false);
    expect(haltOf(a)).toBeNull();
  });

  it("terminates on an error that is its own cause", () => {
    const a = plain(1);
    a.cause = a;
    expect(nodeRateLimited(a)).toBe(false);
  });

  it("still detects a signal inside the cycle", () => {
    const a = plain(1);
    const b = textError();
    a.cause = b;
    b.cause = a;
    expect(nodeRateLimited(a)).toBe(true);
    expect(haltOf(a)).toBe(NODE_RATE_LIMITED);
  });
});
