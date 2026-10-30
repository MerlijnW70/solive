import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "@intent-engine/core";
import { patiently, RATE_LIMIT_ATTEMPTS, rateLimited, refusedUnsent } from "../src/transport.js";

const httpError = (statusCode: number, retryAfter?: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    message: "refused",
    statusCode,
  });

const jsonRpcError = (code: number) => Object.assign(new Error("json rpc"), { name: "SolanaError", context: { __code: code } });

function nested(depth: number, at: number, message: string): Error {
  let error = new Error(at === depth - 1 ? message : "plain");
  for (let i = depth - 2; i >= 0; i--) {
    error = new Error(i === at ? message : "plain", { cause: error });
  }
  return error;
}

describe("how deep the cause chain is read", () => {
  it("finds a rate limit in the eighth link and not in the ninth", () => {
    expect(rateLimited(nested(12, 7, "HTTP error (429): Too Many Requests"))).toBe(true);
    expect(rateLimited(nested(12, 8, "HTTP error (429): Too Many Requests"))).toBe(false);
  });
});

describe("how many times a rate limited call is tried", () => {
  it("makes exactly the attempt limit of calls and then throws the last error", async () => {
    let calls = 0;
    const waits: number[] = [];
    const failure = httpError(429, "0");
    await expect(
      patiently(
        async () => {
          calls += 1;
          throw failure;
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(RATE_LIMIT_ATTEMPTS);
    expect(waits).toStrictEqual(Array.from({ length: RATE_LIMIT_ATTEMPTS - 1 }, () => 0));
  });
});

describe("which refusals prove nothing was sent", () => {
  it("is false for an error of the sdk itself", () => {
    expect(refusedUnsent(new InvalidInput("amount", "range", "out of range"))).toBe(false);
  });

  it("is true for a 4xx answer from 400 up to 499 and false outside", () => {
    expect(refusedUnsent(httpError(399))).toBe(false);
    expect(refusedUnsent(httpError(400))).toBe(true);
    expect(refusedUnsent(httpError(450))).toBe(true);
    expect(refusedUnsent(httpError(499))).toBe(true);
    expect(refusedUnsent(httpError(500))).toBe(false);
    expect(refusedUnsent(httpError(200))).toBe(false);
  });

  it("is true for a json-rpc code from -32768 up to -32000 and false outside", () => {
    expect(refusedUnsent(jsonRpcError(-31_999))).toBe(false);
    expect(refusedUnsent(jsonRpcError(-32_000))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_602))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_768))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_769))).toBe(false);
  });
});
