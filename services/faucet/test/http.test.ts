import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { REASONS } from "../src/drip.js";
import { createHandler, envDeps } from "../src/http.js";
import { DEFAULT_RPC_URL, MAX_BODY_BYTES } from "../src/limits.js";
import { NOT_JSON } from "../src/request.js";
import { FakeNode, harness, newFaucet, type Faucet } from "./fake-node.js";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: unknown };
type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

let faucet: Faucet;
let recipient: Address;

beforeAll(async () => {
  faucet = await newFaucet();
  recipient = (await generateKeyPairSigner()).address;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function serve<T>(handler: Handler, run: (call: (method: string, body?: string, headers?: Record<string, string>) => Promise<Reply>) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = (method: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/drip", method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text === "" ? undefined : JSON.parse(text) });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  try {
    return await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function routeFetch(node: FakeNode, urls: string[]): void {
  vi.stubGlobal("fetch", async (url: string | URL, init: { body: string }) => {
    urls.push(String(url));
    const reply = await node.transport({ payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("http handler", () => {
  it("answers a POST with the contract body as json", async () => {
    const h = harness(faucet);
    await serve(createHandler(h.deps), async (call) => {
      const reply = await call("POST", JSON.stringify({ address: recipient }), { "content-type": "application/json" });
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).toEqual({ signature: h.node.sent[0]?.signature, lamports: "500000000" });
    });
  });

  it("answers 405 with an allow header for other methods", async () => {
    const h = harness(faucet);
    await serve(createHandler(h.deps), async (call) => {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const reply = await call(method);
        expect(reply).toMatchObject({ status: 405, body: { error: REASONS.method } });
        expect(reply.headers["allow"]).toBe("POST");
      }
      expect(h.node.calls).toEqual([]);
    });
  });

  it("answers 400 for a malformed or oversized body", async () => {
    const h = harness(faucet);
    await serve(createHandler(h.deps), async (call) => {
      expect(await call("POST", "nope")).toMatchObject({ status: 400, body: { error: NOT_JSON } });
      expect(await call("POST")).toMatchObject({ status: 400, body: { error: NOT_JSON } });
      const padded = JSON.stringify({ address: recipient + " ".repeat(MAX_BODY_BYTES) });
      expect(await call("POST", padded)).toMatchObject({ status: 400, body: { error: NOT_JSON } });
      expect(h.node.calls).toEqual([]);
    });
  });

  it("limits callers by the first forwarded ip and sets retry-after", async () => {
    const h = harness(faucet);
    const addresses = await Promise.all(Array.from({ length: 4 }, async () => (await generateKeyPairSigner()).address));
    await serve(createHandler(h.deps), async (call) => {
      for (const address of addresses.slice(0, 3)) {
        expect((await call("POST", JSON.stringify({ address }), { "x-forwarded-for": "198.51.100.9, 10.0.0.1" })).status).toBe(200);
      }
      const reply = await call("POST", JSON.stringify({ address: addresses[3] }), { "x-forwarded-for": "198.51.100.9" });
      expect(reply.status).toBe(429);
      expect(reply.headers["retry-after"]).toBe(String((reply.body as { retry_after: number }).retry_after));
    });
  });
});

describe("function wired to the environment", () => {
  it("uses the devnet url by default and reads the key at request time", async () => {
    vi.stubEnv("FAUCET_RPC_URL", "");
    vi.stubEnv("FAUCET_SECRET", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const node = new FakeNode(faucet);
    const urls: string[] = [];
    routeFetch(node, urls);
    const handler = (await import("../api/drip.js")).default as Handler;
    await serve(handler, async (call) => {
      expect(await call("POST", JSON.stringify({ address: recipient }))).toMatchObject({ status: 503, body: { error: REASONS.config } });
      vi.stubEnv("FAUCET_SECRET", faucet.secret);
      const reply = await call("POST", JSON.stringify({ address: recipient }), { "x-forwarded-for": "198.51.100.10" });
      expect(reply).toMatchObject({ status: 200, body: { lamports: "500000000" } });
      expect(node.sent[0]?.from).toBe(faucet.address);
    });
    expect(DEFAULT_RPC_URL).toBe("https://" + "api.devnet.solana.com");
    expect(new Set(urls)).toEqual(new Set([DEFAULT_RPC_URL]));
  });

  it("refuses to send through a FAUCET_RPC_URL that is not devnet", async () => {
    const other = "https://" + "rpc.example";
    vi.stubEnv("FAUCET_RPC_URL", other);
    vi.stubEnv("FAUCET_SECRET", faucet.secret);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    const node = new FakeNode(faucet);
    node.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const urls: string[] = [];
    routeFetch(node, urls);
    await serve(createHandler(envDeps(new CallerLimit())), async (call) => {
      expect(await call("POST", JSON.stringify({ address: recipient }))).toMatchObject({ status: 503, body: { error: REASONS.cluster } });
    });
    expect(node.methods()).toEqual(["getGenesisHash"]);
    expect(node.sent).toEqual([]);
    expect(new Set(urls)).toEqual(new Set([other]));
    expect(logged).toEqual([JSON.stringify({ status: 503 })]);
  });
});
