import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { rpcTransport } from "@intent-engine/client/internal";
import { timedRpc } from "../src/main.js";
import { JobReads, type JobToRead } from "../src/job-reads.js";

const address = getAddressDecoder().decode(new Uint8Array(32).fill(5)) as Address;
const job: JobToRead = { intent: address, createdAt: 1n, owner: address, specHash: new Uint8Array(32) };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answer = (res: ServerResponse, id: unknown) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: null } }));
};
const idOf = (req: IncomingMessage, then: (id: unknown) => void) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => then((JSON.parse(body) as { id: unknown }).id));
};

let servers: Server[] = [];

async function serve(handle: (req: IncomingMessage, res: ServerResponse, count: number) => void) {
  let count = 0;
  const server = createServer((req, res) => handle(req, res, ++count));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: "http://" + "127.0.0.1:" + (server.address() as AddressInfo).port, count: () => count };
}

afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
});

describe("closing the job reads", () => {
  it("drops a node request that never answers", async () => {
    let dropped: number | undefined;
    let closedAt = 0;
    const node = await serve((req, res) => {
      res.on("close", () => (dropped = performance.now() - closedAt));
    });
    const transport = rpcTransport(timedRpc(node.url, 30_000));
    const reads = new JobReads();
    reads.start(transport, job, false, (reach) => reach.getAccount(address).then(() => false));
    await wait(200);
    expect(node.count()).toBe(1);
    closedAt = performance.now();
    reads.close();
    await wait(500);
    expect(dropped).toBeLessThan(400);
  });

  it("stops the wait before a rate-limited request is asked again", async () => {
    const node = await serve((req, res) => {
      res.statusCode = 429;
      res.end("slow down");
    });
    const transport = rpcTransport(timedRpc(node.url, 30_000));
    const reads = new JobReads();
    reads.start(transport, job, false, (reach) => reach.getAccount(address).then(() => false));
    await wait(300);
    expect(node.count()).toBe(1);
    reads.close();
    await wait(2_500);
    expect(node.count()).toBe(1);
  });

  it("leaves a request of another tool running to its answer", async () => {
    const node = await serve((req, res) => {
      idOf(req, (id) => setTimeout(() => answer(res, id), 600));
    });
    const transport = rpcTransport(timedRpc(node.url, 30_000));
    const reads = new JobReads();
    reads.start(transport, job, false, (reach) => reach.getAccount(address).then(() => false));
    await wait(100);
    const other = transport.getAccount(address);
    await wait(100);
    reads.close();
    expect(await other).toBeNull();
  });

  it("leaves the rate-limit wait of another tool's request running until it is answered", async () => {
    const node = await serve((req, res, count) => {
      idOf(req, (id) => {
        if (count <= 2) {
          res.statusCode = 429;
          res.end("slow down");
          return;
        }
        answer(res, id);
      });
    });
    const transport = rpcTransport(timedRpc(node.url, 30_000));
    const reads = new JobReads();
    const other = transport.getAccount(address);
    await wait(100);
    reads.start(transport, job, false, (reach) => reach.getAccount(address).then(() => false));
    await wait(100);
    expect(node.count()).toBe(2);
    reads.close();
    expect(await other).toBeNull();
    expect(node.count()).toBe(3);
  });

  it("does not hand a transaction read a closed background read started to another tool", async () => {
    const sig = "5".repeat(88) as Signature;
    const entry = { signature: sig, slot: 1n, failed: false, memo: null, blockTime: null } as never;
    const node = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: unknown; method: string };
        const reply = () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "getSignaturesForAddress" ? [] : method === "getAccountInfo" ? { context: { slot: 1 }, value: null } : null }));
        };
        if (method === "getTransaction") {
          setTimeout(reply, 600);
          return;
        }
        reply();
      });
    });
    const transport = rpcTransport(timedRpc(node.url, 30_000));
    const reads = new JobReads();
    let began = false;
    reads.start(transport, job, false, async (reach) => {
      began = true;
      await (reach.transactionsOf as NonNullable<typeof reach.transactionsOf>)([entry]);
      return false;
    });
    await wait(150);
    expect(began).toBe(true);
    const before = node.count();
    const other = (transport.transactionsOf as NonNullable<typeof transport.transactionsOf>)([entry]);
    await wait(100);
    expect(node.count()).toBe(before + 1);
    reads.close();
    expect(await other).toHaveLength(1);
  });
});
