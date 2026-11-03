import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Blockhash, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND, SolanaError } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidInput } from "@intent-engine/core";
import { createClient, MaybeSent, RateLimited, ReplyTooLarge, WrongReplyLength } from "../src/index.js";
import { memoized, type RpcLike, rpcTransport, type Transport } from "../src/internal.js";
import { cappedTransport, onNode, replyHeaders } from "../src/capped-transport.js";
import { OTHER, OWNER, signatureOfWire, signedWire } from "./transport-stub.js";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LATEST = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n };
const ACCOUNT = { owner: OWNER, data: ["AQID", "base64"] as const, lamports: 7n, executable: false };

function shortNode(accounts: unknown[], statuses: unknown[]) {
  const rpc = {
    getMultipleAccounts: () => ({ send: async () => ({ context: { slot: 1n }, value: accounts }) }),
    getSignatureStatuses: () => ({ send: async () => ({ context: { slot: 1n }, value: statuses }) }),
    sendTransaction: (wire: string) => ({ send: async () => signatureOfWire(wire) }),
    getEpochInfo: () => ({ send: async () => ({ blockHeight: 10n, absoluteSlot: 10n }) }),
  };
  return rpcTransport(rpc as unknown as RpcLike, async () => undefined);
}

describe("a reply with the wrong number of entries is an error", () => {
  it("refuses a getMultipleAccounts reply shorter than asked instead of reading the rest as missing", async () => {
    const failure = await shortNode([ACCOUNT], []).getAccounts([OWNER, OTHER]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongReplyLength);
    expect(failure).toMatchObject({ code: "wrong-reply-length", method: "getMultipleAccounts", asked: 2, answered: 1 });
  });

  it("refuses a getMultipleAccounts reply longer than asked and one that is not a list", async () => {
    await expect(shortNode([ACCOUNT, null, null], []).getAccounts([OWNER, OTHER])).rejects.toMatchObject({ asked: 2, answered: 3 });
    await expect(shortNode({ length: 2 } as unknown as unknown[], []).getAccounts([OWNER, OTHER])).rejects.toMatchObject({ asked: 2, answered: null });
  });

  it("reads a reply of the right length as before", async () => {
    const views = await shortNode([ACCOUNT, null], []).getAccounts([OWNER, OTHER]);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ owner: OWNER, lamports: 7n });
    expect(views[1]).toBeNull();
  });

  it("refuses a getSignatureStatuses reply shorter than asked instead of reading the rest as not landed", async () => {
    const asked = [signatureOfWire(await signedWire()), signatureOfWire(await signedWire())];
    const failure = await shortNode([], [{ err: null, confirmationStatus: "confirmed", slot: 1n }]).signatureStatuses?.(asked).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongReplyLength);
    expect(failure).toMatchObject({ method: "getSignatureStatuses", asked: 2, answered: 1 });
  });

  it("refuses an empty status reply while confirming a send, so the send reports maybe sent", async () => {
    const failure = await shortNode([], []).sendWire(await signedWire(), LATEST).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect((failure as MaybeSent).cause).toBeInstanceOf(WrongReplyLength);
  });

  it("refuses an empty status reply to a status read", async () => {
    const signature = signatureOfWire(await signedWire());
    await expect(shortNode([], []).sendStatus?.(signature, 5n)).rejects.toBeInstanceOf(WrongReplyLength);
  });

  it("refuses an empty late status read once the blockhash has passed, instead of reporting the send expired", async () => {
    const rpc = {
      sendTransaction: (wire: string) => ({ send: async () => signatureOfWire(wire) }),
      getSignatureStatuses: (_signatures: unknown, config?: { searchTransactionHistory?: boolean }) => ({
        send: async () => ({ context: { slot: 50n }, value: config?.searchTransactionHistory === true ? [] : [null] }),
      }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 200n, absoluteSlot: 40n }) }),
    };
    const failure = await rpcTransport(rpc as unknown as RpcLike, async () => undefined).sendWire(await signedWire(), LATEST).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MaybeSent);
    expect((failure as MaybeSent).cause).toBeInstanceOf(WrongReplyLength);
  });

  it("refuses an empty status read after a stale blockhash refusal, instead of reporting the blockhash expired", async () => {
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          throw new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND);
        },
      }),
      getSignatureStatuses: () => ({ send: async () => ({ context: { slot: 50n }, value: [] }) }),
    };
    const failure = await rpcTransport(rpc as unknown as RpcLike, async () => undefined).submitWire(await signedWire()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongReplyLength);
    expect(failure).toMatchObject({ method: "getSignatureStatuses", asked: 1, answered: 0 });
  });

  it("refuses a short answer from the transport under the memo instead of reading accounts as missing", async () => {
    const inner = { getAccounts: async () => [null], getAccount: async () => null } as unknown as Transport;
    const failure = await memoized(inner).getAccounts([OWNER, OTHER]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongReplyLength);
    expect(failure).toMatchObject({ method: "getAccounts", asked: 2, answered: 1 });
  });
});

type Answer = { status?: number; headers?: Record<string, string>; body: string };

type Served = { url: string; bodies: string[]; headers: Record<string, string | string[] | undefined>[]; close(): Promise<void> };

let open: Served[] = [];

afterEach(async () => {
  await Promise.all(open.map((served) => served.close()));
  open = [];
});

async function jsonNode(answer: (request: { method: string; id: unknown }) => Answer): Promise<Served> {
  const bodies: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      headers.push(request.headers);
      const found = answer(JSON.parse(body) as { method: string; id: unknown });
      response.writeHead(found.status ?? 200, { "content-type": "application/json", ...found.headers }).end(found.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const served = {
    url: "http://127.0.0.1:" + String((server.address() as AddressInfo).port),
    bodies,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(served);
  return served;
}

const result = (id: unknown, value: string) => `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${value}}`;

describe("an optional cap on the bytes of an RPC reply", () => {
  it("refuses a reply over the cap with ReplyTooLarge naming the method and the cap", async () => {
    const node = await jsonNode(({ id }) => ({ body: result(id, JSON.stringify(GENESIS + " ".repeat(4_096))) }));
    const failure = await createClient({ url: node.url, maxReplyBytes: 1_024 }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReplyTooLarge);
    expect(failure).toMatchObject({ code: "reply-too-large", method: "getGenesisHash", maxReplyBytes: 1_024 });
  });

  it("stops reading an endless reply at the cap and closes the connection", async () => {
    let written = 0;
    let closed = false;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(16_384, 32);
      const timer = setInterval(() => {
        written += chunk.byteLength;
        response.write(chunk);
      }, 1);
      response.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    open.push({ url: "", bodies: [], headers: [], close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
    const url = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
    const failure = await createClient({ url, maxReplyBytes: 65_536 }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReplyTooLarge);
    await expect.poll(() => closed).toBe(true);
    expect(written).toBeLessThan(16 * 1_048_576);
  });

  it("refuses a reply one byte over the cap and reads one exactly at it", async () => {
    const node = await jsonNode(() => ({ body: result("fixed", JSON.stringify(GENESIS)) }));
    const size = Buffer.byteLength(result("fixed", JSON.stringify(GENESIS)));
    expect(await createClient({ url: node.url, maxReplyBytes: size }).transport.genesisHash()).toBe(GENESIS);
    await expect(createClient({ url: node.url, maxReplyBytes: size - 1 }).transport.genesisHash()).rejects.toBeInstanceOf(ReplyTooLarge);
  });

  it("reads any size when unset", async () => {
    const padded = GENESIS + " ".repeat(4_096);
    const node = await jsonNode(({ id }) => ({ body: result(id, JSON.stringify(padded)) }));
    expect(await createClient({ url: node.url }).transport.genesisHash()).toBe(padded);
  });

  it("keeps whole numbers exact as bigints and decimals as numbers, as the default transport does", async () => {
    const node = await jsonNode(({ id, method }) => ({
      body:
        method === "getLatestBlockhash"
          ? result(id, `{"context":{"slot":5},"value":{"blockhash":"${LATEST.blockhash}","lastValidBlockHeight":18446744073709551615}}`)
          : result(id, `[{"slot":3,"prioritizationFee":1.5}]`),
    }));
    const transport = createClient({ url: node.url, maxReplyBytes: 4_096 }).transport;
    expect(await transport.latestBlockhash()).toStrictEqual({ blockhash: LATEST.blockhash, lastValidBlockHeight: 18_446_744_073_709_551_615n });
    expect(await transport.recentFees([])).toStrictEqual([1.5]);
  });

  it("sends bigint params as plain JSON numbers", async () => {
    const node = await jsonNode(({ id }) => ({ body: result(id, "null") }));
    await cappedTransport(node.url, 1_024)({ payload: { jsonrpc: "2.0", id: "1", method: "getBlock", params: [18_446_744_073_709_551_615n, { note: '{"$n":"1"}' }] } });
    expect(node.bodies).toStrictEqual(['{"jsonrpc":"2.0","id":"1","method":"getBlock","params":[18446744073709551615,{"note":"{\\"$n\\":\\"1\\"}"}]}']);
  });

  it("sends kit's headers for the platform, accept-encoding only on node, and no solana-client", async () => {
    expect(onNode()).toBe(true);
    expect(replyHeaders(true)).toStrictEqual({ "accept-encoding": "br,gzip,deflate", accept: "application/json", "content-type": "application/json; charset=utf-8" });
    expect(replyHeaders(false)).toStrictEqual({ accept: "application/json", "content-type": "application/json; charset=utf-8" });
    const node = await jsonNode(({ id }) => ({ body: result(id, JSON.stringify(GENESIS)) }));
    await createClient({ url: node.url }).transport.genesisHash();
    await createClient({ url: node.url, maxReplyBytes: 1_024 }).transport.genesisHash();
    const [plain, capped] = node.headers;
    expect(capped?.["solana-client"]).toBeUndefined();
    expect(capped?.["accept-encoding"]).toBe(plain?.["accept-encoding"]);
    expect(capped?.["content-type"]).toBe(plain?.["content-type"]);
    expect(capped?.["accept"]).toBe(plain?.["accept"]);
  });

  it("keeps a 429 a rate limit, with the node's retry-after", async () => {
    const node = await jsonNode(() => ({ status: 429, headers: { "retry-after": "2" }, body: "slow down" }));
    const failure = await createClient({ url: node.url, maxReplyBytes: 1_024, retry: false }).transport.genesisHash().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimited);
    expect(failure).toMatchObject({ method: "getGenesisHash", retryAfterMs: 2_000 });
  });

  it("refuses a cap that is not a whole number of bytes from 1 to 2147483647", () => {
    for (const cap of [0, -1, 1.5, 2_147_483_648, Number.NaN, "1024"]) {
      expect(() => createClient({ url: "http://127.0.0.1:1", maxReplyBytes: cap as number }), String(cap)).toThrow(InvalidInput);
    }
    expect(() => createClient({ url: "http://127.0.0.1:1", maxReplyBytes: 1 })).not.toThrow();
    expect(() => createClient({ url: "http://127.0.0.1:1", maxReplyBytes: 2_147_483_647 })).not.toThrow();
  });

  it("refuses a cap together with an rpcTransport, which it cannot measure", () => {
    const rpcTransport = (async () => ({})) as never;
    expect(() => createClient({ url: "http://127.0.0.1:1", rpcTransport, maxReplyBytes: 1_024 })).toThrow(expect.objectContaining({ field: "maxReplyBytes", rule: "conflict" }));
  });
});
