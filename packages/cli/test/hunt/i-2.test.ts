import { type Address, generateKeyPairSigner, isAddress } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK } from "../../src/main.js";
import { ADDRESS_PATTERN } from "../../src/agent/schema.js";
import { cli, h, type World, world } from "../harness.js";

type Problem = { code: string; hint: string };
type Result = { isError?: boolean; content: unknown; structuredContent?: unknown };

const NON_CANONICAL = "1".repeat(44);

describe("a wallet tool resolving a mint name", () => {
  let w: World;
  let client: Client;

  beforeAll(async () => {
    w = await world();
    h.served.length = 0;
    const started = await cli(["mcp", "--url", "localnet", "--wallet", "--all-tools"], {});
    expect(started.code).toBe(EXIT_OK);
    const server = h.served[0];
    if (server === undefined) {
      throw new Error("no server was started");
    }
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    client = new Client({ name: "hunter", version: "0.0.0" });
    await client.connect(far);
    const setup = await client.callTool({ name: "solive_wallet_setup", arguments: {} });
    const wallet = (setup.structuredContent as { address?: Address }).address ?? (await generateKeyPairSigner()).address;
    h.watched.length = 0;
    h.watched.push(wallet);
  });

  const call = (name: string, args: unknown) =>
    client.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<Result>;

  it("I-2: a wallet tool takes a non-canonical base58 string as a mint instead of refusing it with a usage problem", async () => {
    expect(NON_CANONICAL).toMatch(new RegExp(ADDRESS_PATTERN));
    expect(isAddress(NON_CANONICAL)).toBe(false);
    const result = await call("solive_wallet_estimate", { sell: NON_CANONICAL, buy: w.outputMint, amount: "1" });
    expect(result.isError).toBe(true);
    const problem = result.structuredContent as Problem;
    expect(problem.code).toBe("InvalidInput");
  }, 120_000);
});
