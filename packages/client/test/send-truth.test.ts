import { type Blockhash, type RpcTransport, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type Signature, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Cancelled, createClient, MaybeSent, RateLimited } from "../src/index.js";
import { type RpcLike, rpcTransport } from "../src/internal.js";
import { signatureOfWire, signedWire } from "./transport-stub.js";

const DEVNET = "https://api.devnet.solana.com";
const LATEST = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n };

type Request = { method: string; id?: unknown };

const tooMany = (statusCode = 429, retryAfter = "3") =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "retry-after": retryAfter }), message: "Too Many Requests", statusCode });

function attemptsNode(failures: readonly unknown[]) {
  let sends = 0;
  const rpc = {
    sendTransaction: () => ({
      send: async () => {
        sends += 1;
        throw failures[Math.min(sends, failures.length) - 1];
      },
    }),
  };
  return { rpc: rpc as unknown as RpcLike, sends: () => sends };
}

function nodeOf(answer: (request: Request) => Promise<unknown> | unknown) {
  const asked: string[] = [];
  const rpcTransport = (async ({ payload }: { payload: unknown }) => {
    const request = payload as Request;
    asked.push(request.method);
    return { jsonrpc: "2.0", id: request.id, result: await answer(request) };
  }) as RpcTransport;
  return { rpcTransport, asked };
}

function statusNode(sendAnswer: (wire: string) => Promise<string>, statuses: () => Promise<unknown>) {
  const asked: string[] = [];
  const rpc = {
    sendTransaction: (wire: string) => ({
      send: async () => {
        asked.push("sendTransaction");
        return sendAnswer(wire);
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        asked.push("getSignatureStatuses");
        return statuses();
      },
    }),
    getEpochInfo: () => ({
      send: async () => {
        asked.push("getEpochInfo");
        return { blockHeight: 10n, absoluteSlot: 10n };
      },
    }),
  };
  return { rpc: rpc as unknown as RpcLike, asked };
}

describe("a send that never reached the node is not reported as maybe sent", () => {
  it("rejects with Cancelled, unwrapped, when the signal aborted before the send was issued", async () => {
    const node = nodeOf(() => {
      throw new Error("the node was asked");
    });
    const stop = new AbortController();
    stop.abort();
    const client = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal });
    const failure = await client.transport.submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
    expect(failure).toMatchObject({ code: "cancelled", method: "sendTransaction" });
    expect(node.asked).toStrictEqual([]);
  });

  it("still reports maybe sent when the signal aborts a send already in flight", async () => {
    const stop = new AbortController();
    const node = nodeOf(async () => {
      stop.abort();
      return new Promise(() => undefined);
    });
    const client = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal });
    const wire = await signedWire();
    const failure = await client.transport.submitWire(wire).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect(failure).toMatchObject({ signature: signatureOfWire(wire), lastValidBlockHeight: null });
    expect((failure as MaybeSent).cause).toBeInstanceOf(Cancelled);
    expect(node.asked).toStrictEqual(["sendTransaction"]);
  });

  it("still reports maybe sent when the signal aborts the retry wait after an attempt that may have reached the node", async () => {
    const stop = new AbortController();
    const node = nodeOf(() => {
      setTimeout(() => stop.abort(), 5);
      throw new Error("upstream answered 429 after taking the request");
    });
    const client = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, signal: stop.signal });
    const wire = await signedWire();
    const failure = await client.transport.submitWire(wire).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect(failure).toMatchObject({ signature: signatureOfWire(wire) });
    expect((failure as MaybeSent).cause).toBeInstanceOf(Cancelled);
    expect(node.asked).toStrictEqual(["sendTransaction"]);
  });

  it("reports maybe sent when a retried send ends in a 429 under retry: false, since the first attempt may have reached the node", async () => {
    const node = attemptsNode([new Error("minimum context slot not reached"), tooMany()]);
    const failure = await rpcTransport(node.rpc, async () => undefined, undefined, undefined, false).submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect((failure as MaybeSent).cause).toBeInstanceOf(RateLimited);
    expect(node.sends()).toBe(2);
  });

  it("reports maybe sent when retries after a vague 429 end in a real 429", async () => {
    const node = attemptsNode([new Error("upstream said 429 after taking the request"), tooMany(429, "0")]);
    const failure = await rpcTransport(node.rpc, async () => undefined).submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect(node.sends()).toBe(6);
  });

  it("reports maybe sent when a retry after a vague 429 cannot connect", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), { code: "ECONNREFUSED" }) });
    const node = attemptsNode([new Error("upstream said 429 after taking the request"), refused]);
    const failure = await rpcTransport(node.rpc, async () => undefined).submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect((failure as MaybeSent).cause).toBe(refused);
    expect(node.sends()).toBe(2);
  });

  it("rejects with RateLimited, unwrapped, when the node refused the send with a 429 under retry: false", async () => {
    const node = nodeOf(() => {
      throw tooMany();
    });
    const client = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false });
    const failure = await client.transport.submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect(failure).toMatchObject({ code: "rate-limited", method: "sendTransaction", retryAfterMs: 3_000 });
    expect(node.asked).toStrictEqual(["sendTransaction"]);
  });

  it("still reports maybe sent for a RateLimited whose cause does not prove the node refused the send", async () => {
    const vague = new Error("upstream said 429 after taking the request");
    const node = nodeOf(() => {
      throw vague;
    });
    const client = createClient({ url: DEVNET, rpcTransport: node.rpcTransport, retry: false });
    const failure = await client.transport.submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect((failure as MaybeSent).cause).toBeInstanceOf(RateLimited);
  });

  it("still reports maybe sent for an sdk error raised after the node may have taken the bytes", async () => {
    const node = nodeOf(() => {
      throw new Cancelled("sendTransaction");
    });
    const failure = await createClient({ url: DEVNET, rpcTransport: node.rpcTransport }).transport.submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
  });
});

describe("retry: false holds for confirmation and status reads", () => {
  it("rejects a confirmation that hits a 429 at once, as maybe sent caused by RateLimited, without waiting", async () => {
    const waits: number[] = [];
    const node = statusNode(
      async (wire) => signatureOfWire(wire),
      async () => {
        throw tooMany();
      },
    );
    const transport = rpcTransport(node.rpc, async (ms) => {
      waits.push(ms);
    }, undefined, undefined, false);
    const wire = await signedWire();
    const failure = await transport.sendWire(wire, LATEST).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect(failure).toMatchObject({ signature: signatureOfWire(wire), lastValidBlockHeight: LATEST.lastValidBlockHeight });
    expect((failure as MaybeSent).cause).toBeInstanceOf(RateLimited);
    expect((failure as MaybeSent).cause).toMatchObject({ method: "getSignatureStatuses", retryAfterMs: 3_000 });
    expect(node.asked).toStrictEqual(["sendTransaction", "getSignatureStatuses"]);
    expect(waits).toStrictEqual([]);
  });

  it("rejects a status read that hits a 429 at once with RateLimited, without waiting", async () => {
    const waits: number[] = [];
    const node = statusNode(
      async (wire) => signatureOfWire(wire),
      async () => {
        throw tooMany();
      },
    );
    const transport = rpcTransport(node.rpc, async (ms) => {
      waits.push(ms);
    }, undefined, undefined, false);
    const signature = signatureOfWire(await signedWire()) as Signature;
    const failure = await transport.sendStatus?.(signature, 5n).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect(failure).toMatchObject({ method: "getSignatureStatuses" });
    expect(node.asked).toStrictEqual(["getEpochInfo", "getSignatureStatuses"]);
    expect(waits).toStrictEqual([]);
  });

  it("still retries a confirmation 429 when retry is left on", async () => {
    let calls = 0;
    const node = statusNode(
      async (wire) => signatureOfWire(wire),
      async () => {
        calls += 1;
        if (calls === 1) {
          throw tooMany();
        }
        return { context: { slot: 9n }, value: [{ err: null, confirmationStatus: "confirmed", slot: 9n }] };
      },
    );
    const transport = rpcTransport(node.rpc, async () => undefined);
    const wire = await signedWire();
    expect(await transport.sendWire(wire, LATEST)).toBe(signatureOfWire(wire));
    expect(node.asked).toStrictEqual(["sendTransaction", "getSignatureStatuses", "getSignatureStatuses"]);
  });
});
