import { type Address, type RpcTransport, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { Cancelled, createClient, RateLimited, TimedOut } from "../src/index.js";
import { testSignature } from "../src/testing.js";
import { waitUnless } from "../src/rpc-limits.js";

const DEVNET = "https://api.devnet.solana.com";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

type Request = { method: string; params?: unknown[]; id?: unknown };

type Node = { rpcTransport: RpcTransport; asked: Request[] };

function nodeOf(answer: (request: Request, signal: AbortSignal | undefined) => Promise<unknown> | unknown): Node {
  const asked: Request[] = [];
  const rpcTransport = (async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }) => {
    const request = payload as Request;
    asked.push(request);
    return { jsonrpc: "2.0", id: request.id, result: await answer(request, signal) };
  }) as RpcTransport;
  return { rpcTransport, asked };
}

const tooMany = (retryAfter?: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    message: "Too Many Requests",
    statusCode: 429,
  });

const failingOnce = (error: unknown) => {
  let calls = 0;
  return nodeOf(() => {
    calls += 1;
    if (calls === 1) {
      throw error;
    }
    return GENESIS;
  });
};

const hangs = (signal: AbortSignal | undefined) =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retry", () => {
  it("still retries a 429 by default", async () => {
    const node = failingOnce(tooMany("0"));
    expect(await createClient({ url: DEVNET, rpcTransport: node.rpcTransport }).transport.genesisHash()).toBe(GENESIS);
    expect(node.asked).toHaveLength(2);
  });

  it("rejects a 429 once with RateLimited carrying the node's retry-after when retry is false", async () => {
    const node = failingOnce(tooMany("7"));
    const failure = await createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect(failure).toMatchObject({ code: "rate-limited", method: "getGenesisHash", retryAfterMs: 7_000 });
    expect((failure as RateLimited).cause).toBeInstanceOf(SolanaError);
    expect(node.asked).toHaveLength(1);
  });

  it("gives retryAfterMs null when the node names no wait", async () => {
    const node = failingOnce(tooMany());
    await expect(createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false }).transport.genesisHash()).rejects.toMatchObject({ retryAfterMs: null });
  });

  it("passes any other failure through unchanged", async () => {
    const refused = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Bad Gateway", statusCode: 502 });
    const node = failingOnce(refused);
    await expect(createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false }).transport.genesisHash()).rejects.toBe(refused);
  });

  it("carries an HTTP-date retry-after into RateLimited as milliseconds from now", async () => {
    const seconds = 60;
    const inAMinute = new Date(Date.now() + seconds * 1000).toUTCString();
    const failure = await createClient({ url: DEVNET, rpcTransport: failingOnce(tooMany(inAMinute)).rpcTransport, retry: false }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    const { retryAfterMs } = failure as RateLimited;
    expect(retryAfterMs).toBeGreaterThan((seconds - 5) * 1000);
    expect(retryAfterMs).toBeLessThanOrEqual(seconds * 1000);
    const past = new Date(Date.now() - seconds * 1000).toUTCString();
    await expect(createClient({ url: DEVNET, rpcTransport: failingOnce(tooMany(past)).rpcTransport, retry: false }).transport.genesisHash()).rejects.toMatchObject({ retryAfterMs: 0 });
  });

  it("rejects a 429 from the HTTP transport it builds from the url after one request", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
    });
    await expect(createClient({ url: DEVNET, retry: false, timeoutMs: 5_000 }).transport.genesisHash()).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 3_000 });
    expect(fetched).toBe(1);
  });
});

describe("timeoutMs", () => {
  it("aborts a call that runs past it with TimedOut", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const node = nodeOf((_, signal) => {
      seen.push(signal);
      return hangs(signal);
    });
    const failure = await createClient({ url: DEVNET, rpcTransport: node.rpcTransport, timeoutMs: 20 }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TimedOut);
    expect(failure).toMatchObject({ code: "timed-out", method: "getGenesisHash", timeoutMs: 20 });
    expect(seen[0]?.aborted).toBe(true);
  });

  it("gives up on a transport that ignores the abort", async () => {
    const node = nodeOf(() => new Promise(() => undefined));
    await expect(createClient({ url: DEVNET, rpcTransport: node.rpcTransport, timeoutMs: 20 }).transport.genesisHash()).rejects.toBeInstanceOf(TimedOut);
  });

  it("answers a call that ends in time, and applies to the HTTP transport it builds from the url", async () => {
    const node = nodeOf(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return GENESIS;
    });
    expect(await createClient({ url: DEVNET, rpcTransport: node.rpcTransport, timeoutMs: 1_000 }).transport.genesisHash()).toBe(GENESIS);
    vi.stubGlobal("fetch", async (_: unknown, init: { signal?: AbortSignal }) => hangs(init.signal ?? undefined));
    await expect(createClient({ url: DEVNET, timeoutMs: 20 }).transport.genesisHash()).rejects.toMatchObject({ code: "timed-out", timeoutMs: 20 });
  });

  it("refuses a timeout that is not a whole positive number of milliseconds, and a retry that is not a boolean", () => {
    for (const timeoutMs of [0, -1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => createClient({ url: DEVNET, timeoutMs }), String(timeoutMs)).toThrow(expect.objectContaining({ code: "invalid-input", field: "timeoutMs" }));
    }
    expect(() => createClient({ url: DEVNET, timeoutMs: 2 ** 31 - 1, retry: false })).not.toThrow();
    expect(() => createClient({ url: DEVNET, retry: "no" as never })).toThrow(expect.objectContaining({ code: "invalid-input", field: "retry" }));
  });
});

describe("signal", () => {
  it("issues no call once it has aborted", async () => {
    const stop = new AbortController();
    const node = nodeOf(() => GENESIS);
    const { transport } = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal });
    expect(await transport.genesisHash()).toBe(GENESIS);
    stop.abort();
    const failure = await transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
    expect(failure).toMatchObject({ code: "cancelled", method: "getGenesisHash" });
    expect(node.asked).toHaveLength(1);
  });

  it("abandons a call in flight, passes the abort to the transport, and works without timeoutMs", async () => {
    const stop = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const node = nodeOf((_, signal) => {
      seen.push(signal);
      return new Promise(() => undefined);
    });
    const reading = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal }).transport.genesisHash();
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop.abort();
    await expect(reading).rejects.toBeInstanceOf(Cancelled);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("applies to the HTTP transport it builds from the url", async () => {
    const stop = new AbortController();
    stop.abort();
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      return new Response("{}");
    });
    await expect(createClient({ url: DEVNET, signal: stop.signal }).activity()).rejects.toMatchObject({ code: "cancelled", method: "getSignaturesForAddress" });
    expect(fetched).toBe(0);
  });

  it("ends a retry wait as soon as it aborts, without another call", async () => {
    const stop = new AbortController();
    const node = failingOnce(tooMany("3"));
    const started = performance.now();
    const reading = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal }).transport.genesisHash();
    setTimeout(() => stop.abort(), 10);
    await expect(reading).rejects.toBeInstanceOf(Cancelled);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(node.asked).toHaveLength(1);
  });

  it("ends a wait at once when the signal has already aborted", async () => {
    const started = performance.now();
    await waitUnless(AbortSignal.abort())(60_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("still retries after the wait when it has not aborted", async () => {
    const node = failingOnce(tooMany("0"));
    expect(await createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: new AbortController().signal }).transport.genesisHash()).toBe(GENESIS);
    expect(node.asked).toHaveLength(2);
  });

  it("with a timeout too, on a transport that ignores the abort: the timer ends the call with TimedOut", async () => {
    const node = nodeOf(() => new Promise(() => undefined));
    const reading = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, timeoutMs: 20, signal: new AbortController().signal }).transport.genesisHash();
    await expect(reading).rejects.toBeInstanceOf(TimedOut);
  });

  it("with a timeout too, on a transport that ignores the abort: the signal ends the call with Cancelled", async () => {
    const stop = new AbortController();
    const node = nodeOf(() => new Promise(() => undefined));
    const reading = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, timeoutMs: 60_000, signal: stop.signal }).transport.genesisHash();
    setTimeout(() => stop.abort(), 10);
    await expect(reading).rejects.toBeInstanceOf(Cancelled);
  });

  it("refuses a signal that is not an AbortSignal", () => {
    expect(() => createClient({ url: DEVNET, signal: {} as AbortSignal })).toThrow(expect.objectContaining({ code: "invalid-input", field: "signal" }));
  });
});

describe("activity over the RPC transport", () => {
  const listedOnce = (count: number) => Array.from({ length: count }, (_, i) => ({ signature: testSignature(i + 1), slot: i + 1, blockTime: 10, err: null, memo: null }));

  it("costs one listing plus one getTransaction per transaction, 101 calls for a default page", async () => {
    const node = nodeOf(({ method }) => (method === "getSignaturesForAddress" ? listedOnce(100) : null));
    await createClient({ url: DEVNET, rpcTransport: node.rpcTransport }).activity();
    expect(node.asked.filter(({ method }) => method === "getSignaturesForAddress")).toHaveLength(1);
    expect(node.asked.filter(({ method }) => method === "getTransaction")).toHaveLength(100);
  });

  it("reports a transaction the node returned null for and hands out no cursor", async () => {
    const node = nodeOf(({ method }) => (method === "getSignaturesForAddress" ? listedOnce(1) : null));
    expect(await createClient({ url: DEVNET, rpcTransport: node.rpcTransport }).activity()).toEqual({
      events: [],
      newest: null,
      next: null,
      complete: false,
      unread: [testSignature(1)],
    });
  });

  it("discards the page when a later batch is rate limited with retry false", async () => {
    let listings = 0;
    const node = nodeOf(({ method }) => {
      if (method !== "getSignaturesForAddress") {
        return null;
      }
      listings += 1;
      if (listings === 2) {
        throw tooMany("4");
      }
      return listedOnce(100);
    });
    await expect(createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false }).activity({ limit: 200 })).rejects.toBeInstanceOf(RateLimited);
  });

  it("honours retry false and timeoutMs", async () => {
    const limited = failingOnce(tooMany("4"));
    await expect(createClient({ url: DEVNET, rpcTransport: limited.rpcTransport, retry: false }).activity()).rejects.toMatchObject({
      code: "rate-limited",
      method: "getSignaturesForAddress",
      retryAfterMs: 4_000,
    });
    expect(limited.asked).toHaveLength(1);
    const slow = nodeOf((_, signal) => hangs(signal));
    await expect(createClient({ url: DEVNET, rpcTransport: slow.rpcTransport, timeoutMs: 20 }).activity()).rejects.toMatchObject({ code: "timed-out", method: "getSignaturesForAddress" });
  });

  it("lists the program with until and stops there", async () => {
    const node = nodeOf(() => []);
    expect(await createClient({ url: DEVNET, rpcTransport: node.rpcTransport }).activity({ until: testSignature(1), limit: 7 })).toEqual({ events: [], newest: null, next: null, complete: true, unread: [] });
    expect(node.asked.map(({ method, params }) => [method, params?.[0], params?.[1]])).toEqual([
      ["getSignaturesForAddress", INTENT_ENGINE_PROGRAM_ADDRESS, expect.objectContaining({ limit: 7, until: testSignature(1) })],
    ]);
  });
});

describe("the until cursor of the RPC transport", () => {
  it("lists only signatures newer than until, and sends no until when none is given", async () => {
    const node = nodeOf(() => [{ signature: testSignature(2), slot: 2, blockTime: 20, err: null, memo: null }]);
    const { transport } = createClient({ url: DEVNET, rpcTransport: node.rpcTransport });
    const listed = await transport.signaturesOf?.(INTENT_ENGINE_PROGRAM_ADDRESS, 5, undefined, testSignature(1));
    expect(listed?.map(({ signature }) => signature)).toEqual([testSignature(2)]);
    await transport.signaturesOf?.(INTENT_ENGINE_PROGRAM_ADDRESS, 5, testSignature(9));
    expect(node.asked.map(({ params }) => params)).toEqual([
      [INTENT_ENGINE_PROGRAM_ADDRESS, expect.objectContaining({ limit: 5, until: testSignature(1) })],
      [INTENT_ENGINE_PROGRAM_ADDRESS, expect.objectContaining({ limit: 5, before: testSignature(9) })],
    ]);
    expect(node.asked[1]?.params?.[1]).not.toHaveProperty("until");
  });

  it("refuses an until that is not a signature before asking the node", async () => {
    const node = nodeOf(() => []);
    const { transport } = createClient({ url: DEVNET, rpcTransport: node.rpcTransport });
    await expect(transport.signaturesOf?.("11111111111111111111111111111111" as Address, 5, undefined, "nope")).rejects.toMatchObject({ code: "invalid-input", field: "until" });
    expect(node.asked).toEqual([]);
  });
});
