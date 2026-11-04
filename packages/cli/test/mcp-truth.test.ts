import { type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { getCloseAccountInstruction, getTransferInstruction } from "@solana-program/token";
import { PREVIEW_LINE, rawUnitsLine, SEND_FIELD_LINE, sendsAtOnceLine, WHOLE_TOKENS } from "../src/agent/mcp.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { execute, grantOf, ok, order } from "./agent-mandate-kit.js";
import { ata, balance, cli, funded, h, send, type World, world } from "./harness.js";

const NAMES = /\bsolive_\w+/g;

type Served = { client: Client; tools: string[]; instructions: string; texts: string[] };

async function served(argv: string[], signers: Record<string, KeyPairSigner>): Promise<Served> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", ...argv], signers);
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const { tools } = await client.listTools();
  const prompts = await Promise.all((await client.listPrompts()).prompts.map(async ({ name }) => JSON.stringify((await client.getPrompt({ name })).messages)));
  const texts = [...tools.flatMap((one) => [one.description ?? "", JSON.stringify(one.inputSchema), JSON.stringify(one.outputSchema ?? {})]), ...prompts];
  return { client, tools: tools.map((one) => one.name), instructions: client.getInstructions() ?? "", texts };
}

const unserved = (texts: readonly string[], tools: readonly string[]): string[] => [...new Set(texts.flatMap((text) => [...text.matchAll(NAMES)].map(([name]) => name)))].filter((name) => !tools.includes(name));

describe("what a wallet server tells the agent", () => {
  let w: World;
  let relayer: KeyPairSigner;
  let agent: KeyPairSigner;
  const relaying = () => ["--relayer", "r.json", "--relay-fee", `${NATIVE_MINT}=0`];
  const acting = () => ["--agent", "a.json", "--agent-owners", w.owner.address];
  const keys = () => ({ "r.json": relayer, "a.json": agent });

  beforeEach(async () => {
    w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    relayer = await funded();
    agent = await funded();
  });

  it("promises a preview and whole tokens with --wallet alone, where every signing tool previews and takes whole tokens", async () => {
    const { instructions } = await served(["--wallet"], keys());
    expect(instructions).toContain(PREVIEW_LINE);
    expect(instructions).toContain(WHOLE_TOKENS);
    expect(instructions).not.toContain(SEND_FIELD_LINE);
    expect(instructions).not.toContain("raw units");
  });

  it("says which tools send at once and which take raw units with --wallet --agent and --wallet --relayer", async () => {
    const cases = [
      { argv: [...acting()], sends: ["agent_create"], raw: ["prepare_mandate", "prepare_agent_create", "agent_create"] },
      { argv: [...relaying()], sends: ["submit_signed_intent"], raw: ["prepare_signed_intent", "preview_signed_intent", "submit_signed_intent"] },
      {
        argv: [...relaying(), ...acting()],
        sends: ["submit_signed_intent", "agent_create"],
        raw: ["prepare_signed_intent", "preview_signed_intent", "submit_signed_intent", "prepare_mandate", "prepare_agent_create", "agent_create"],
      },
    ];
    for (const { argv, sends, raw } of cases) {
      const { instructions, tools } = await served(["--wallet", ...argv], keys());
      expect([argv, instructions.includes(PREVIEW_LINE), instructions.includes(WHOLE_TOKENS)]).toEqual([argv, false, false]);
      expect(instructions).toContain(SEND_FIELD_LINE);
      expect(instructions).toContain("- This wallet pays only after you approve a preview.");
      expect(instructions).not.toMatch(/Nothing moves|payments are previewed/);
      expect(sends.some((name) => name.startsWith("wallet_"))).toBe(false);
      expect(instructions).toContain(sendsAtOnceLine(sends.map(tool)));
      expect(instructions).toContain(rawUnitsLine(raw.map(tool)));
      expect(raw.map(tool).every((name) => tools.includes(name))).toBe(true);
    }
  });

  it("names only served tools in its instructions, descriptions, schemas and prompts, for every served set", async () => {
    for (const argv of [["--wallet"], ["--wallet", ...relaying()], ["--wallet", ...acting()], ["--wallet", ...relaying(), ...acting()], ["--wallet", "--all-tools"]]) {
      const { tools, instructions, texts } = await served(argv, keys());
      expect([argv, unserved([instructions, ...texts], tools)]).toEqual([argv, []]);
    }
  });

  it("names no unserved tool in a revoke summary with --wallet --agent", async () => {
    const { client, tools } = await served(["--wallet", ...acting()], keys());
    expect(tools).not.toContain(tool("prepare_cancel"));
    await execute((await ok(client, "prepare_mandate", grantOf(w, agent)))["prepared"], w.owner);
    for (const amount of ["300", "200"]) {
      await ok(client, "agent_create", { owner: w.owner.address, order: order(amount, "150"), expires_in: 600 });
    }
    const elsewhere = await ata(w.authority, w.feeRecipient.address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: elsewhere, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    const revoke = await ok(client, "prepare_revoke_mandate", { owner: w.owner.address, agent: agent.address });
    const summary = revoke["summary"] as string[];
    expect(summary.filter((line) => line.startsWith("Does not cancel"))).toHaveLength(2);
    expect(summary.some((line) => line.startsWith("Leaves 2 more of its intents open but unfillable"))).toBe(true);
    expect(unserved([JSON.stringify(revoke)], tools)).toEqual([]);
  });
});
