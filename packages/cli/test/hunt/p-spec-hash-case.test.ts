import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_OK } from "../../src/main.js";
import { ata, cli, h, world, type World } from "../harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect(started.code).toBe(EXIT_OK);
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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

describe("the escrow spec preflight", () => {
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

  it("P-2: owner commits a spec_hash in upper-case hex that is the sha256 of the published bytes", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    await ata(scene.authority, owner, scene.inputMint, 10_000_000n);
    const spec = "the acceptance spec the work must pass\n";
    const bytes = new TextEncoder().encode(spec);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const specHash = digest.toUpperCase();
    expect(specHash).toMatch(/^[0-9A-F]{64}$/);
    expect(specHash.toLowerCase()).toBe(digest);
    const url = "https://" + "example.org/jobs/spec.md";
    h.specPages.set(url, bytes);
    const preview = await ok(client, "wallet_escrow", {
      sell: scene.inputMint,
      amount: "0.05",
      attestor: owner,
      record_mint: scene.outputMint,
      spec_hash: specHash,
      spec_url: url,
    });
    const warnings = (preview["warnings"] as string[]) ?? [];
    expect(warnings.some((warning) => warning.includes("hashes to"))).toBe(false);
  });
});
