import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { GLOBAL_OPTIONS } from "../src/args.js";
import { tool } from "../src/agent/names.js";
import { main, nodeRuntime } from "../src/main.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SDK_CLIENT = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const SECRET_PATH = "/rpc/team-7f3a";
const SECRET_QUERY = "?api-key=s3cret";

type Node = { url: string; methods: string[]; server: Server };

const RESULTS: Record<string, (params: unknown[]) => unknown> = {
  getGenesisHash: () => DEVNET_GENESIS_HASH,
  getAccountInfo: () => ({ context: { slot: 1 }, value: null }),
  getMultipleAccounts: (params) => ({ context: { slot: 1 }, value: (params[0] as unknown[]).map(() => null) }),
};

async function fakeNode(limitedFirst: boolean): Promise<Node> {
  const methods: string[] = [];
  let limit = limitedFirst;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] };
      methods.push(method);
      if (limit) {
        limit = false;
        response.writeHead(429, { "retry-after": "0" }).end();
        return;
      }
      const result = RESULTS[method];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id, result: result(params ?? []) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = new URL("http://127.0.0.1:1");
  target.port = String((server.address() as AddressInfo).port);
  return { url: `${target.origin}${SECRET_PATH}${SECRET_QUERY}`, methods, server };
}

const nodes: Node[] = [];

async function started(limitedFirst = false): Promise<Node> {
  const made = await fakeNode(limitedFirst);
  nodes.push(made);
  return made;
}

describe("the --debug flag", () => {
  afterEach(async () => {
    for (const { server } of nodes.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
    vi.restoreAllMocks();
  });

  it("is accepted by every command, as the client page says", () => {
    expect(GLOBAL_OPTIONS).toContain("debug");
    expect(SDK_CLIENT).toContain("the CLI and MCP server take `--debug`, which writes the lines to stderr.");
  });

  it("keeps stdout valid JSON while stderr holds the log, retry included, and shows the node url without its path or query", async () => {
    const node = await started(true);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["domain", "--url", node.url, "--debug"], nodeRuntime(), { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ genesisHash: DEVNET_GENESIS_HASH });
    expect(out.join("\n")).not.toMatch(/request #|response #/);
    expect(err[0]).toBe("request #1 getGenesisHash attempt 1");
    expect(err[1]).toMatch(/^response #1 getGenesisHash attempt 1 \d+ms failed: /);
    expect(err[2]).toBe("retry getGenesisHash after attempt 1 in 0ms: rate-limited");
    expect(err[3]).toBe("request #2 getGenesisHash attempt 2");
    expect(err[4]).toMatch(/^response #2 getGenesisHash attempt 2 \d+ms$/);
    expect(node.methods.filter((method) => method === "getGenesisHash").length).toBeGreaterThanOrEqual(2);
    expect(err.join("\n")).not.toMatch(/team-7f3a|api-key|s3cret/);
  });

  it("writes nothing extra without the flag", async () => {
    const node = await started();
    const err: string[] = [];
    expect(await main(["domain", "--url", node.url], nodeRuntime(), { out: () => undefined, err: (t) => err.push(t) })).toBe(0);
    expect(err).toEqual([]);
  });

  it("makes the MCP server log to stderr and never to stdout, where only protocol messages go", { timeout: 30_000 }, async () => {
    const node = await started();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const err: string[] = [];
    const out: string[] = [];
    const serving = main(["mcp", "--url", node.url, "--debug"], nodeRuntime(Date.now, { stdin, stdout }), { out: (t) => out.push(t), err: (t) => err.push(t) });
    const ask = (id: number, method: string, params: object) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const replies = () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    ask(2, "tools/call", { name: tool("get_config"), arguments: {} });
    await vi.waitFor(() => expect(replies().map((reply) => reply["id"])).toEqual([1, 2]), { timeout: 20_000 });
    stdin.end();
    expect(await serving).toBe(0);
    expect(replies().every((reply) => reply["jsonrpc"] === "2.0")).toBe(true);
    expect(written.join("")).not.toMatch(/request #|response #/);
    expect(out).toEqual([]);
    expect(err.some((line) => /^request #\d+ getAccountInfo attempt 1$/.test(line))).toBe(true);
    expect(node.methods).toContain("getAccountInfo");
  });
});
