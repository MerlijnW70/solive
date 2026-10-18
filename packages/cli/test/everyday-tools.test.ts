import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { AGENT_TOOLS, EVERYDAY_TOOLS, RELAY_TOOLS, servedActions } from "../src/agent/everyday.js";
import { instructionsFor, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import { ACTIONS } from "../src/agent/registry.js";
import { WALLET_ACTIONS, WALLET_NOTICE } from "../src/agent/wallet.js";
import { tool } from "../src/agent/names.js";
import { ALL_TOOLS_NEED_WALLET, parse } from "../src/args.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, h, world } from "./harness.js";

const EVERY = [...WALLET_ACTIONS, ...ACTIONS].map((a) => a.name);

async function served(argv: string[], signers: Record<string, KeyPairSigner> = {}): Promise<{ tools: string[]; instructions: string | undefined }> {
  h.served.length = 0;
  const started = await cli(argv, signers);
  expect([started.code, started.err]).toEqual([EXIT_OK, argv.includes("--wallet") ? WALLET_NOTICE.join("\n") : ""]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  return { tools: tools.map((t) => t.name), instructions };
}

describe("the tools a server serves", () => {
  let relayer: KeyPairSigner;
  let agent: KeyPairSigner;
  const relaying = () => ["--relayer", "r.json", "--relay-fee", `${NATIVE_MINT}=0`];
  const acting = () => ["--agent", "a.json", "--agent-owners", agent.address];

  beforeEach(async () => {
    await world();
    h.files.clear();
    relayer = await generateKeyPairSigner();
    agent = await generateKeyPairSigner();
  });

  it("serves at most 26 everyday tools with --wallet, wallet tools first, and tells the AI only about those", async () => {
    const { tools, instructions } = await served(["mcp", "--url", "devnet", "--wallet"]);
    expect(tools.length).toBeLessThanOrEqual(26);
    expect(tools).toEqual(EVERY.filter((name) => EVERYDAY_TOOLS.has(name)));
    expect(new Set(tools)).toEqual(EVERYDAY_TOOLS);
    expect(tools).toEqual(
      [
        "wallet_setup",
        "wallet_balance",
        "wallet_estimate",
        "wallet_swap",
        "wallet_auction",
        "wallet_recurring",
        "wallet_escrow",
        "wallet_escrow_plan",
        "wallet_attest",
        "wallet_attest_split",
        "wallet_feedback",
        "wallet_claim",
        "wallet_record_delivery",
        "wallet_deliver",
        "wallet_check_delivery",
        "wallet_wait",
        "wallet_receipt",
        "wallet_intents",
        "wallet_history",
        "wallet_cancel",
        "wallet_unwrap",
        "find_jobs",
        "get_spec",
        "hash",
        "get_reputation",
        "get_claims",
      ].map(tool),
    );
    expect(instructions).toBe(instructionsFor(servedActions({ wallet: true, allTools: false, relay: false, agent: false })));
    for (const line of WALLET_NOTICE) {
      expect(instructions).toContain(`- ${line}`);
    }
    const named = new Set([...(instructions ?? "").matchAll(/\bsolive_\w+/g)].map(([name]) => name));
    expect([...named].filter((name) => !tools.includes(name))).toEqual([]);
    expect(named).toContain(tool("wallet_setup"));
    expect(instructions).not.toContain(tool("wallet_committee_vote"));
  });

  it("serves every tool with --wallet --all-tools, as before, with the full instructions", async () => {
    const { tools, instructions } = await served(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(tools).toEqual(EVERY);
    expect(tools.length).toBeGreaterThan(20);
    expect(instructions).toBe(WALLET_INSTRUCTIONS);
  });

  it("still brings the relay tools with --relayer and the mandate tools with --agent", async () => {
    const relayed = await served(["mcp", "--url", "devnet", "--wallet", ...relaying()], { "r.json": relayer });
    expect(relayed.tools).toEqual(EVERY.filter((name) => EVERYDAY_TOOLS.has(name) || RELAY_TOOLS.has(name)));
    expect(relayed.tools).toEqual(expect.arrayContaining([...RELAY_TOOLS]));
    expect(relayed.tools).not.toContain(tool("agent_create"));

    const agented = await served(["mcp", "--url", "devnet", "--wallet", ...acting()], { "a.json": agent });
    expect(agented.tools).toEqual(EVERY.filter((name) => EVERYDAY_TOOLS.has(name) || AGENT_TOOLS.has(name)));
    expect(agented.tools).toEqual(expect.arrayContaining([...AGENT_TOOLS]));
    expect(agented.tools).not.toContain(tool("submit_signed_intent"));

    const both = await served(["mcp", "--url", "devnet", "--wallet", ...relaying(), ...acting()], { "r.json": relayer, "a.json": agent });
    expect(both.tools).toEqual(EVERY.filter((name) => EVERYDAY_TOOLS.has(name) || RELAY_TOOLS.has(name) || AGENT_TOOLS.has(name)));
    for (const name of [...RELAY_TOOLS, ...AGENT_TOOLS]) {
      expect(ACTIONS.map((a) => a.name)).toContain(name);
    }
  });

  it("leaves a server without --wallet unchanged, with or without --relayer and --agent", async () => {
    const names = ACTIONS.map((a) => a.name);
    expect(await served(["mcp", "--url", "devnet"])).toEqual({ tools: names, instructions: undefined });
    expect((await served(["mcp", "--url", "devnet", ...relaying()], { "r.json": relayer })).tools).toEqual(names);
    expect((await served(["mcp", "--url", "devnet", ...acting()], { "a.json": agent })).tools).toEqual(names);
    expect(servedActions({ wallet: false, allTools: false, relay: true, agent: true })).toBe(ACTIONS);
  });

  it("parses --all-tools only alongside --wallet", async () => {
    expect(parse(["mcp", "--url", "devnet", "--wallet"], {})).toMatchObject({ name: "mcp", allTools: false });
    expect(parse(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {})).toMatchObject({ name: "mcp", allTools: true });
    expect(parse(["mcp", "--url", "devnet"], {})).toMatchObject({ name: "mcp", allTools: false, wallet: null });
    expect(() => parse(["mcp", "--url", "devnet", "--all-tools"], {})).toThrow(ALL_TOOLS_NEED_WALLET);
    h.served.length = 0;
    const refused = await cli(["mcp", "--url", "devnet", "--all-tools"], {});
    expect([refused.code, refused.err]).toEqual([EXIT_USAGE, ALL_TOOLS_NEED_WALLET]);
    expect(h.served).toHaveLength(0);
  });
});
