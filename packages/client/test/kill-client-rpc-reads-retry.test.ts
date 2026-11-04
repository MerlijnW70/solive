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

  it("is true only for a 4xx answer that proves refusal, never for 408, 425 or 499, and false outside 4xx", () => {
    expect(refusedUnsent(httpError(399))).toBe(false);
    expect(refusedUnsent(httpError(400))).toBe(true);
    expect(refusedUnsent(httpError(408))).toBe(false);
    expect(refusedUnsent(httpError(425))).toBe(false);
    expect(refusedUnsent(httpError(431))).toBe(true);
    expect(refusedUnsent(httpError(450))).toBe(false);
    expect(refusedUnsent(httpError(499))).toBe(false);
    expect(refusedUnsent(httpError(500))).toBe(false);
    expect(refusedUnsent(httpError(200))).toBe(false);
  });

  it("is true only for a json-rpc code that proves refusal, false for the other codes from -32768 up to -32000 and outside", () => {
    expect(refusedUnsent(jsonRpcError(-31_999))).toBe(false);
    expect(refusedUnsent(jsonRpcError(-32_000))).toBe(false);
    expect(refusedUnsent(jsonRpcError(-32_002))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_602))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_603))).toBe(false);
    expect(refusedUnsent(jsonRpcError(-32_700))).toBe(true);
    expect(refusedUnsent(jsonRpcError(-32_768))).toBe(false);
    expect(refusedUnsent(jsonRpcError(-32_769))).toBe(false);
  });

  it("stops at the first answer from the node and reads a connection refusal only below one from outside the json-rpc range", () => {
    const unreached = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const answered = (code: number) => Object.assign(new Error("json rpc", { cause: unreached }), { name: "SolanaError", context: { __code: code } });
    expect(refusedUnsent(new Error("http", { cause: unreached }))).toBe(true);
    expect(refusedUnsent(Object.assign(httpError(408), { cause: unreached }))).toBe(false);
    expect(refusedUnsent(answered(-31_999))).toBe(true);
    expect(refusedUnsent(answered(-32_000))).toBe(false);
    expect(refusedUnsent(answered(-32_768))).toBe(false);
    expect(refusedUnsent(answered(-32_769))).toBe(true);
  });
});
