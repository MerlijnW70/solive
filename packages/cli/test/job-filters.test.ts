import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { MIN_PAY_FORMAT as TOOL_MIN_PAY_FORMAT } from "../src/agent/read.js";
import { MIN_PAY_FORMAT } from "../src/job-args.js";
import { leastUnits } from "../src/job-filters.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { ata, cli, h, NOW, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const specHash = new Uint8Array(32).fill(7);
const proof = (attestor: Address, amountIn: bigint) => ({ kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n }) as const;

async function linked(): Promise<Client> {
  const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf() });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

describe("jobs filtered by what they pay", () => {
  let w: World;
  let first: Address;
  let second: Address;
  let small: Address;
  let large: Address;
  let other: Address;

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    await ata(w.authority, w.owner.address, w.outputMint, 1_000n);
    first = (await generateKeyPairSigner()).address;
    second = (await generateKeyPairSigner()).address;
    const client = createClient({ url: "http://cluster", transport });
    const selling = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
    const buying = { signer: w.owner, inputMint: w.outputMint, outputMint: w.inputMint };
    small = (await client.createIntent({ ...selling, params: proof(first, 100n), nonce: 1n, expiresAt: NOW + 3_600n })).intent;
    large = (await client.createIntent({ ...selling, params: proof(second, 300n), nonce: 2n, expiresAt: NOW + 3_601n })).intent;
    other = (await client.createIntent({ ...buying, params: proof(first, 500n), nonce: 3n, expiresAt: NOW + 3_602n })).intent;
  });

  const listed = async (...args: string[]) => {
    const result = await cli(["jobs", ...args], {});
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return (result.json()["jobs"] as { intent: Address }[]).map(({ intent }) => intent);
  };

  it("lists every job with no filter", async () => {
    expect(await listed()).toEqual([other, large, small]);
  });

  it("the command filters by mint, by least pay in whole tokens, and by both with the judge", async () => {
    expect(await listed("--mint", w.inputMint)).toEqual([large, small]);
    expect(await listed("--mint", w.outputMint)).toEqual([other]);
    expect(await listed("--mint", "SOL")).toEqual([]);
    expect(await listed("--min-pay", "0")).toEqual([other, large, small]);
    expect(await listed("--min-pay", "0.0003")).toEqual([other, large]);
    expect(await listed("--min-pay", "0.00030001")).toEqual([other]);
    expect(await listed("--min-pay", "0.0006")).toEqual([]);
    expect(await listed("--mint", w.inputMint, "--min-pay", "0.0002")).toEqual([large]);
    expect(await listed("--attestor", first, "--min-pay", "0.0001")).toEqual([other, small]);
    expect(await listed("--attestor", first, "--mint", w.outputMint, "--min-pay", "0.0005")).toEqual([other]);
    expect(await listed("--attestor", second, "--mint", w.outputMint)).toEqual([]);
  });

  it("the command refuses a least pay that is not a token amount and TEST off devnet", async () => {
    expect(await cli(["jobs", "--min-pay", "lots"], {})).toMatchObject({ code: EXIT_USAGE, err: MIN_PAY_FORMAT });
    expect((await cli(["jobs", "--mint", "TEST"], {})).code).toBe(EXIT_USAGE);
  });

  it("rounds a least pay finer than the token up to the next base unit", () => {
    expect(leastUnits("0.0003", 6)).toBe(300n);
    expect(leastUnits("0.00030001", 6)).toBe(301n);
    expect(leastUnits("2", 0)).toBe(2n);
    expect(leastUnits("2.5", 0)).toBe(3n);
    expect(leastUnits("1.5", 9)).toBe(1_500_000_000n);
  });

  it("solive_find_jobs filters by mint, min_pay and both, and lists every job with neither", async () => {
    const client = await linked();
    const found = async (args: Json) => {
      const result = await client.callTool({ name: "solive_find_jobs", arguments: args });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      return ((result.structuredContent as Json)["jobs"] as { intent: Address }[]).map(({ intent }) => intent);
    };
    expect(await found({})).toEqual([other, large, small]);
    expect(await found({ mint: w.inputMint })).toEqual([large, small]);
    expect(await found({ mint: "SOL" })).toEqual([]);
    expect(await found({ min_pay: "0.0003" })).toEqual([other, large]);
    expect(await found({ min_pay: "0.00030001" })).toEqual([other]);
    expect(await found({ mint: w.inputMint, min_pay: "0.0002" })).toEqual([large]);
    expect(await found({ attestor: first, mint: w.outputMint, min_pay: "0.0005" })).toEqual([other]);
    expect(await found({ attestor: second, min_pay: "0.0004" })).toEqual([]);
    const refused = await client.callTool({ name: "solive_find_jobs", arguments: { min_pay: "lots" } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "InvalidInput", issues: [{ path: "min_pay", message: TOOL_MIN_PAY_FORMAT }] });
    const unnamed = await client.callTool({ name: "solive_find_jobs", arguments: { mint: "not a mint" } });
    expect(unnamed.structuredContent).toMatchObject({ code: "InvalidInput", issues: [{ path: "mint" }] });
  });
});
