import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Blockhash,
  getSolanaErrorFromJsonRpcError,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
} from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { BlockhashExpired, createClient, isSdkError, MaybeSent } from "../src/index.js";
import { REFUSED_RPC_CODES, REFUSED_STATUSES, type RpcLike, refusedUnsent, rpcTransport } from "../src/internal.js";
import { signatureOfWire, signedWire } from "./transport-stub.js";

const LATEST = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n };

const httpError = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "gateway answer", statusCode });

const rpcError = (code: number, data: unknown = {}) => getSolanaErrorFromJsonRpcError({ code, message: "node answer", data });

const KEPT_STATUSES = [400, 401, 403, 404, 405, 407, 411, 413, 414, 415, 421, 429, 431];

const KEPT_CODES = [-32700, -32600, -32601, -32602, -32002, -32003, -32005, -32006, -32013, -32015, -32016];

type Served = { url: string; sends: number; close(): Promise<void> };

let open: Served[] = [];

afterEach(async () => {
  await Promise.all(open.map((served) => served.close()));
  open = [];
});

async function gateway(status: number): Promise<Served> {
  const served: Served = { url: "", sends: 0, close: async () => undefined };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { method } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
      if (method === "sendTransaction") {
        served.sends += 1;
      }
      response.writeHead(status, { "content-type": "text/plain" }).end("gateway answer");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  served.url = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
  served.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  open.push(served);
  return served;
}

const failure = (pending: Promise<unknown>) => pending.then(() => null, (error: unknown) => error);

describe("which answers to a send prove the node refused it before processing", () => {
  it("keeps only the listed HTTP statuses as refused, and calls 408, 425 and 499 maybe sent", () => {
    expect([...REFUSED_STATUSES].sort((a, b) => a - b)).toStrictEqual(KEPT_STATUSES);
    for (let status = 100; status < 600; status++) {
      expect(refusedUnsent(httpError(status)), String(status)).toBe(KEPT_STATUSES.includes(status));
    }
    for (const status of [408, 425, 499]) {
      expect(refusedUnsent(httpError(status))).toBe(false);
      expect(refusedUnsent(new Error("wrapped", { cause: httpError(status) }))).toBe(false);
    }
    expect(refusedUnsent(new Error("wrapped", { cause: httpError(400) }))).toBe(true);
  });

  it("keeps only the listed JSON-RPC codes as refused, so an internal or gateway server error is maybe sent", () => {
    expect([...REFUSED_RPC_CODES].sort((a, b) => a - b)).toStrictEqual([...KEPT_CODES].sort((a, b) => a - b));
    for (let code = -32_768; code <= -32_000; code++) {
      expect(refusedUnsent(Object.assign(new Error("node answer"), { name: "SolanaError", context: { __code: code } })), String(code)).toBe(KEPT_CODES.includes(code));
    }
    for (const code of KEPT_CODES) {
      expect(refusedUnsent(rpcError(code)), String(code)).toBe(true);
    }
    expect(refusedUnsent(rpcError(-32_603))).toBe(false);
    expect(refusedUnsent(rpcError(-32_004))).toBe(false);
  });

  it("calls a preflight refusal maybe sent when it says the transaction was already processed", () => {
    expect(refusedUnsent(rpcError(-32_002, { err: "InsufficientFundsForFee" }))).toBe(true);
    expect(refusedUnsent(rpcError(-32_002, { err: "AlreadyProcessed" }))).toBe(false);
    expect(refusedUnsent(new Error("wrapped", { cause: rpcError(-32_002, { err: "AlreadyProcessed" }) }))).toBe(false);
  });
});

describe("a gateway that answers a send with a timeout", () => {
  for (const status of [408, 425]) {
    it(`reports a ${status} from sendWire and submitWire as MaybeSent with the transaction's own signature, sending each once`, async () => {
      for (const maxReplyBytes of [undefined, 1_000_000]) {
        const node = await gateway(status);
        const client = createClient({ url: node.url, ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }) });
        const wire = await signedWire();
        const sent = await failure(client.transport.sendWire(wire, LATEST));
        expect(sent).toBeInstanceOf(MaybeSent);
        expect(sent).toMatchObject({ code: "maybe-sent", signature: signatureOfWire(wire), lastValidBlockHeight: LATEST.lastValidBlockHeight });
        expect(isSolanaError((sent as MaybeSent).cause, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)).toBe(true);
        expect(node.sends).toBe(1);
        const submitted = await failure(client.transport.submitWire(wire));
        expect(submitted).toBeInstanceOf(MaybeSent);
        expect(submitted).toMatchObject({ signature: signatureOfWire(wire), lastValidBlockHeight: null });
        expect(node.sends).toBe(2);
      }
    });
  }

  it("passes a 400 through unchanged as a refusal, not MaybeSent", async () => {
    const node = await gateway(400);
    const client = createClient({ url: node.url });
    const refused = await failure(client.transport.sendWire(await signedWire(), LATEST));
    expect(refused).not.toBeInstanceOf(MaybeSent);
    expect(isSdkError(refused)).toBe(false);
    expect(isSolanaError(refused, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)).toBe(true);
    expect(refusedUnsent(refused)).toBe(true);
    expect(node.sends).toBe(1);
  });
});

describe("a send refused for its blockhash after an earlier attempt that may have reached the node", () => {
  function retried(statuses: () => unknown[]) {
    const sends: unknown[] = [new Error("upstream said 429 after taking the request"), new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)];
    let asked = 0;
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          asked += 1;
          throw sends.shift();
        },
      }),
      getSignatureStatuses: () => ({ send: async () => ({ context: { slot: 50n }, value: statuses() }) }),
    };
    return { transport: rpcTransport(rpc as unknown as RpcLike, async () => undefined), asked: () => asked };
  }

  it("reports MaybeSent, not BlockhashExpired, when the status read finds nothing", async () => {
    const node = retried(() => [null]);
    const wire = await signedWire();
    const error = await failure(node.transport.sendWire(wire, LATEST));
    expect(error).toBeInstanceOf(MaybeSent);
    expect(error).not.toBeInstanceOf(BlockhashExpired);
    expect(error).toMatchObject({ signature: signatureOfWire(wire) });
    expect(node.asked()).toBe(2);
  });

  it("reports MaybeSent, never the status read's own refusal, when that read fails", async () => {
    const unreached = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), { code: "ECONNREFUSED" }) });
    for (const refused of [unreached, httpError(400), rpcError(-32_602)]) {
      expect(refusedUnsent(refused)).toBe(true);
      const node = retried(() => {
        throw refused;
      });
      const wire = await signedWire();
      const error = await failure(node.transport.sendWire(wire, LATEST));
      expect(error).toBeInstanceOf(MaybeSent);
      expect(error).toMatchObject({ signature: signatureOfWire(wire) });
      expect(refusedUnsent(error)).toBe(false);
      expect(node.asked()).toBe(2);
    }
  });

  it("still reports BlockhashExpired when the first attempt was refused for its blockhash", async () => {
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          throw new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND);
        },
      }),
      getSignatureStatuses: () => ({ send: async () => ({ context: { slot: 50n }, value: [null] }) }),
    };
    const error = await failure(rpcTransport(rpc as unknown as RpcLike, async () => undefined).sendWire(await signedWire(), LATEST));
    expect(error).toBeInstanceOf(BlockhashExpired);
  });
});
