import type { Address } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_OK } from "../../src/main.js";
import { WALLET_NOTICE } from "../../src/agent/wallet.js";
import { ata, cli, h, world, type World } from "../harness.js";

type Json = Record<string, any>;

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, argv.includes("--wallet") ? WALLET_NOTICE.join("\n") : ""]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

describe("R-3 the auction's falling curve", () => {
  let client: Client;
  let scene: World;

  beforeEach(async () => {
    scene = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  });

  it("R-3: wallet_auction refuses a start_receive equal to end_receive, so the ask always falls", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    await ata(scene.authority, owner, scene.inputMint, 1_000_000n);
    const args = {
      sell: scene.inputMint,
      buy: scene.outputMint,
      amount: "0.05",
      start_receive: "5",
      end_receive: "5",
      falls_over: 600,
      send: true,
    };
    const flat = await call(client, "wallet_auction", args);
    expect(flat.error).toBe(true);
    const intents = (await ok(client, "wallet_intents"))["intents"] as Json[];
    expect(intents).toEqual([]);
  });
});
