import { getEventListeners } from "node:events";
import type { RpcTransport } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidInput } from "@intent-engine/core";
import { Cancelled, checkedLimits, limitedTransport, RateLimited, TIMEOUT_RANGE, waitUnless } from "../src/rpc-limits.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const abortListeners = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

const refusal = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const call = (payload: unknown) => ({ payload }) as Parameters<RpcTransport>[0];

describe("RateLimited message", () => {
  it("says to read again later when the node names no wait", () => {
    expect(new RateLimited("getSlot", null).message).toBe("the node rate limited getSlot; read again later");
  });

  it("names the wait in milliseconds when the node gave one, zero included", () => {
    expect(new RateLimited("getSlot", 1500).message).toBe("the node rate limited getSlot; read again after 1500 ms");
    expect(new RateLimited("getSlot", 0).message).toBe("the node rate limited getSlot; read again after 0 ms");
  });
});

describe("checkedLimits timeoutMs bounds", () => {
  it("accepts the lowest and the highest whole number", () => {
    expect(() => checkedLimits(1, undefined)).not.toThrow();
    expect(() => checkedLimits(2_147_483_647, undefined)).not.toThrow();
  });

  it("refuses one below and one above with the range rule", () => {
    for (const timeoutMs of [0, 2_147_483_648]) {
      const error = refusal(() => checkedLimits(timeoutMs, undefined));
      expect(error, String(timeoutMs)).toBeInstanceOf(InvalidInput);
      expect(error).toMatchObject({ code: "invalid-input", field: "timeoutMs", rule: "range", message: TIMEOUT_RANGE });
    }
  });
});

describe("limitedTransport method name", () => {
  it("falls back to unknown when the payload is null", async () => {
    const stop = new AbortController();
    stop.abort();
    const base = (async () => ({})) as unknown as RpcTransport;
    const failure = await limitedTransport(base, undefined, stop.signal)(call(null)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
    expect(failure).toMatchObject({ code: "cancelled", method: "unknown" });
  });

  it("names the method of an object payload", async () => {
    const stop = new AbortController();
    stop.abort();
    const base = (async () => ({})) as unknown as RpcTransport;
    const failure = await limitedTransport(base, undefined, stop.signal)(call({ method: "getSlot" })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "cancelled", method: "getSlot" });
  });
});

describe("abort listeners", () => {
  it("leaves no abort listener on the signal a call raced against once it aborted, even if the node never answers", async () => {
    const made: AbortSignal[] = [];
    const real = AbortSignal.any.bind(AbortSignal);
    vi.spyOn(AbortSignal, "any").mockImplementation((signals) => {
      const combined = real(signals);
      made.push(combined);
      return combined;
    });
    const stop = new AbortController();
    const base = (() => new Promise(() => undefined)) as unknown as RpcTransport;
    const settled = limitedTransport(base, undefined, stop.signal)(call({ method: "getSlot" })).catch((error: unknown) => error);
    expect(made.some((signal) => abortListeners(signal) > 0)).toBe(true);
    stop.abort();
    expect(await settled).toBeInstanceOf(Cancelled);
    for (const signal of made) {
      expect(abortListeners(signal)).toBe(0);
    }
  });

  it("leaves no abort listener on a reused signal after a wait ended by the timer or by the abort", async () => {
    const stop = new AbortController();
    const wait = waitUnless(stop.signal);
    await wait(1);
    expect(abortListeners(stop.signal)).toBe(0);
    const pending = wait(60_000);
    expect(abortListeners(stop.signal)).toBe(1);
    stop.abort();
    await pending;
    expect(abortListeners(stop.signal)).toBe(0);
    await wait(60_000);
    expect(abortListeners(stop.signal)).toBe(0);
  });
});
