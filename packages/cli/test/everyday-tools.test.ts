import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { AGENT_TOOLS, EVERYDAY_TOOLS, RELAY_TOOLS, servedActions } from "../src/agent/everyday.js";
import {
  INDEX_HEAD,
  instructionsFor,
  JOB_PROMPTS,
  MARKET_GUIDE,
  MARKET_HEAD,
  MARKET_LINES,
  marketFor,
  promptServed,
  toolIndex,
  TOOL_GROUPS,
  WALLET_INSTRUCTIONS,
} from "../src/agent/mcp.js";
import { ACTIONS } from "../src/agent/registry.js";
import { WALLET_ACTIONS, WALLET_NOTICE } from "../src/agent/wallet.js";
import { tool } from "../src/agent/names.js";
import { ALL_TOOLS_NEED_WALLET, parse } from "../src/args.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, h, world } from "./harness.js";

const EVERY = [...WALLET_ACTIONS, ...ACTIONS].map((a) => a.name);

async function served(
  argv: string[],
  signers: Record<string, KeyPairSigner> = {},
): Promise<{ tools: string[]; instructions: string | undefined; prompts: Record<string, string> }> {
  h.served.length = 0;
  const started = await cli(argv, signers);
  expect([started.code, started.err]).toEqual([EXIT_OK, argv.includes("--wallet") ? WALLET_NOTICE.join("\n") : ""]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  const prompts: Record<string, string> = {};
  if (client.getServerCapabilities()?.prompts !== undefined) {
    for (const { name } of (await client.listPrompts()).prompts) {
      const [message] = (await client.getPrompt({ name })).messages;
      prompts[name] = message?.content.type === "text" ? message.content.text : "";
    }
  }
  await client.close();
  return { tools: tools.map((t) => t.name), instructions, prompts };
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

  it("serves at most 36 everyday tools with --wallet, wallet tools first, and tells the AI only about those", async () => {
    const { tools, instructions } = await served(["mcp", "--url", "devnet", "--wallet"]);
    expect(tools.length).toBeLessThanOrEqual(36);
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
        "wallet_seal_spec",
        "wallet_attest",
        "wallet_attest_split",
        "wallet_committee_create",
        "wallet_committee_vote",
        "wallet_committee_release",
        "wallet_feedback",
        "wallet_claim",
        "wallet_profile",
        "wallet_deliver",
        "wallet_check_delivery",
        "wallet_fetch_work",
        "wallet_judge_work",
        "wallet_refute",
        "wallet_reclaim",
        "wallet_claim_held",
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
        "get_profile",
      ].map(tool),
    );
    expect(instructions).toBe(instructionsFor(servedActions({ wallet: true, allTools: false, relay: false, agent: false })));
    for (const line of WALLET_NOTICE) {
      expect(instructions).toContain(`- ${line}`);
    }
    const named = new Set([...(instructions ?? "").matchAll(/\bsolive_\w+/g)].map(([name]) => name));
    expect([...named].filter((name) => !tools.includes(name))).toEqual([]);
    expect(named).toContain(tool("wallet_setup"));
    expect(new Set(named)).toEqual(new Set(tools));
    expect(instructions).not.toContain(tool("get_config"));
  });

  it("ends the instructions with an index naming each served tool once, one line per group", async () => {
    for (const argv of [["--wallet"], ["--wallet", "--all-tools"]]) {
      const { tools, instructions } = await served(["mcp", "--url", "devnet", ...argv]);
      const lines = (instructions ?? "").split("\n");
      const head = lines.lastIndexOf(INDEX_HEAD);
      const index = lines.slice(head + 1);
      expect(head).toBeGreaterThan(0);
      expect(index.length).toBeLessThanOrEqual(TOOL_GROUPS.length + 1);
      const listed = index.flatMap((line) => {
        const [, group, names] = /^- ([A-Z][a-z]+): (.+)$/.exec(line) ?? [];
        expect([line, group]).toEqual([line, expect.any(String)]);
        return (names ?? "").split(", ");
      });
      expect([...listed].sort()).toEqual([...tools].sort());
      expect(index.some((line) => line.startsWith("- Other:"))).toBe(false);
    }
    expect(toolIndex(servedActions({ wallet: true, allTools: false, relay: false, agent: false }))).toContain(
      `- Judge: ${["wallet_fetch_work", "wallet_judge_work", "wallet_attest", "wallet_attest_split", "wallet_committee_create", "wallet_committee_vote", "wallet_committee_release", "wallet_feedback"].map(tool).join(", ")}`,
    );
    const stray = { ...(WALLET_ACTIONS[0] as (typeof WALLET_ACTIONS)[number]), name: tool("unlisted") };
    expect(toolIndex([stray]).at(-1)).toBe(`- Other: ${tool("unlisted")}`);
  });

  it("serves every tool with --wallet --all-tools, as before, with the full instructions", async () => {
    const { tools, instructions } = await served(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(tools).toEqual(EVERY);
    expect(tools.length).toBeGreaterThan(20);
    expect(instructions).toBe(instructionsFor([...WALLET_ACTIONS, ...ACTIONS]));
    expect(instructions?.startsWith(`${WALLET_INSTRUCTIONS}\n${MARKET_GUIDE}\n${INDEX_HEAD}\n`)).toBe(true);
  });

  it("explains how a job works between the notice and the tool index, naming only served tools", async () => {
    for (const argv of [["--wallet"], ["--wallet", "--all-tools"]]) {
      const { tools, instructions } = await served(["mcp", "--url", "devnet", ...argv]);
      const lines = (instructions ?? "").split("\n");
      const head = lines.indexOf(MARKET_HEAD);
      expect(lines.slice(head + 1, head + 1 + MARKET_LINES.length)).toEqual(MARKET_LINES);
      expect(head).toBeGreaterThan(lines.indexOf(`- ${WALLET_NOTICE.at(-1) ?? ""}`));
      expect(lines.indexOf(INDEX_HEAD)).toBe(head + 1 + MARKET_LINES.length);
      const named = [...MARKET_GUIDE.matchAll(/\bsolive_\w+/g)].map(([name]) => name);
      expect(named.filter((name) => !tools.includes(name))).toEqual([]);
    }
    expect(marketFor([])).toEqual([MARKET_HEAD, ...MARKET_LINES.filter((line) => !/\bsolive_/.test(line))]);
    const lean = [...WALLET_ACTIONS, ...ACTIONS].filter((action) => action.name !== tool("wallet_claim"));
    expect(marketFor(lean)).toEqual([MARKET_HEAD, ...MARKET_LINES.filter((line) => !line.includes(tool("wallet_claim")))]);
  });

  it("offers the hire, earn and judge prompts with a wallet, each naming only served tools, and none without one", async () => {
    for (const argv of [["--wallet"], ["--wallet", "--all-tools"]]) {
      const { tools, prompts } = await served(["mcp", "--url", "devnet", ...argv]);
      expect(Object.keys(prompts)).toEqual(["start", ...JOB_PROMPTS.map((prompt) => prompt.name)]);
      expect(Object.keys(prompts)).toEqual(["start", "hire", "earn", "judge"]);
      for (const prompt of JOB_PROMPTS) {
        expect(prompts[prompt.name]).toBe(prompt.text);
        const named = [...prompt.text.matchAll(/\bsolive_\w+/g)].map(([name]) => name);
        expect(named.length).toBeGreaterThan(1);
        expect([prompt.name, named.filter((name) => !tools.includes(name))]).toEqual([prompt.name, []]);
      }
    }
    expect((await served(["mcp", "--url", "devnet"])).prompts).toEqual({});
    const names = new Set(EVERY.filter((name) => name !== tool("wallet_fetch_work")));
    expect(JOB_PROMPTS.filter((prompt) => promptServed(prompt, names)).map((prompt) => prompt.name)).toEqual(["earn"]);
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
    expect(await served(["mcp", "--url", "devnet"])).toEqual({ tools: names, instructions: undefined, prompts: {} });
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
