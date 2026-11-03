import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodyBuffer, callerOf, createHandler, envDeps, readBody } from "../src/http.js";
import { mirror } from "../src/mirror.js";
import { blobStore } from "../src/store.js";
import { harness, proofIntent, sha, type Harness } from "./harness.js";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function serve<T>(h: Harness, run: (call: (method: string, path: string, body?: Uint8Array, headers?: Record<string, string>) => Promise<Reply>) => Promise<T>): Promise<T> {
  const handler = createHandler(h.deps);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = (method: string, path: string, body?: Uint8Array, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
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

describe("the node handler", () => {
  it("stores and serves binary bytes unchanged with the headers on the wire", async () => {
    const bytes = Uint8Array.from([0, 255, 254, 13, 10, 128]);
    const hex = sha(bytes);
    const h = harness();
    h.node.holds(proofIntent(hex));
    await serve(h, async (call) => {
      expect((await call("PUT", `/sha256/${hex}`, bytes)).status).toBe(201);
      const read = await call("GET", `/sha256/${hex}`);
      expect(read.status).toBe(200);
      expect(Uint8Array.from(read.body)).toStrictEqual(bytes);
      expect(read.headers["content-type"]).toBe("application/octet-stream");
      expect(read.headers["x-content-type-options"]).toBe("nosniff");
      expect(read.headers["cache-control"]).toContain("immutable");
      expect(read.headers["access-control-allow-origin"]).toBe("*");
      const headed = await call("HEAD", `/sha256/${hex}`);
      expect(headed.status).toBe(200);
      expect(headed.headers["content-length"]).toBe(String(bytes.length));
      expect(headed.body).toHaveLength(0);
      expect((await call("GET", "//")).status).toBe(404);
    });
  });

  it("answers 413 to an oversize body the client still receives, and stores nothing", async () => {
    const big = new Uint8Array(MAX_SPEC_BYTES + 1).fill(97);
    const hex = sha(big);
    const h = harness();
    h.node.holds(proofIntent(hex));
    await serve(h, async (call) => {
      expect((await call("PUT", `/sha256/${hex}`, big)).status).toBe(413);
    });
    expect(h.store.writes).toBe(0);
  });

  it("limits by the forwarded caller", async () => {
    const h = harness();
    const seen: string[] = [];
    const retryAfter = h.deps.callers.retryAfter.bind(h.deps.callers);
    vi.spyOn(h.deps.callers, "retryAfter").mockImplementation((caller, now) => {
      seen.push(caller);
      return retryAfter(caller, now);
    });
    await serve(h, async (call) => {
      await call("PUT", `/sha256/${"a".repeat(64)}`, new Uint8Array(), { "x-forwarded-for": "198.51.100.4, 10.0.0.1" });
    });
    expect(seen).toStrictEqual(["198.51.100.4"]);
  });

  it("answers 503 and stores nothing when the upload breaks off", async () => {
    const stream = (async function* () {
      yield Buffer.from("a");
      throw new Error("gone");
    })();
    const h = harness();
    const reply = await mirror({ method: "PUT", url: `/sha256/${"a".repeat(64)}`, caller: "c", body: (limit) => readBody(stream, limit) }, h.deps);
    expect(reply.status).toBe(503);
    expect(h.store.writes).toBe(0);
  });
});

describe("the caller and the body", () => {
  it("takes the first forwarded entry, then x-real-ip, then the socket", () => {
    expect(callerOf({ "x-forwarded-for": " 198.51.100.4 , 10.0.0.1", "x-real-ip": "10.9.9.9" })).toBe("198.51.100.4");
    expect(callerOf({ "x-real-ip": "198.51.100.6" })).toBe("198.51.100.6");
    expect(callerOf({}, "198.51.100.8")).toBe("198.51.100.8");
    expect(callerOf({})).toBe("unknown");
  });

  it("reads a body at the limit and answers null past it", async () => {
    const chunks = async function* (...parts: string[]) {
      for (const part of parts) yield Buffer.from(part);
    };
    expect(await readBody(chunks("ab", "c"), 3)).toStrictEqual(Buffer.from("abc"));
    expect(await readBody(chunks("ab", "cd"), 3)).toBeNull();
  });
});

describe("an oversize body in memory", () => {
  it("keeps the pieces under the limit and lets go of them once the limit is passed, however much more arrives", async () => {
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const settled = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      collect();
    };
    const buffer = new BodyBuffer(10);
    const piece = ((): WeakRef<Buffer> => {
      const added = Buffer.alloc(10);
      buffer.add(added);
      return new WeakRef(added);
    })();
    await settled();
    expect(piece.deref()).toBeDefined();
    buffer.add(Buffer.alloc(1));
    await settled();
    expect(piece.deref()).toBeUndefined();
    buffer.add(Buffer.alloc(1));
    expect(buffer.bytes()).toBeNull();
  });
});

describe("the environment", () => {
  it("defaults to the public devnet node", async () => {
    const urls: string[] = [];
    vi.stubEnv("SPECS_RPC_URL", "");
    vi.stubGlobal("fetch", async (url: string | URL, init: { body: string }) => {
      urls.push(String(url));
      const { id } = JSON.parse(init.body) as { id: unknown };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await envDeps().rpc().getGenesisHash().send();
    expect(urls).toStrictEqual(["https://api.devnet.solana.com"]);
  });

  it("uses the blob store and asks the node in SPECS_RPC_URL", async () => {
    const urls: string[] = [];
    vi.stubEnv("SPECS_RPC_URL", "https://" + "node.example");
    vi.stubGlobal("fetch", async (url: string | URL, init: { body: string }) => {
      urls.push(String(url));
      const { id } = JSON.parse(init.body) as { id: unknown };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "not devnet" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const deps = envDeps();
    expect(deps.store).toBe(blobStore);
    await deps.rpc().getGenesisHash().send();
    expect(urls).toStrictEqual(["https://" + "node.example"]);
  });
});
