import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { generateKeyPairSigner } from "@solana/kit";
import { PRODUCT_SLUG } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/agent/registry.js";
import { EXIT_USAGE } from "../src/main.js";
import { unreachableHint } from "../src/agent/problems.js";

const bin = fileURLToPath(new URL("../dist/src/bin.js", import.meta.url));
const UNREACHABLE = "http://127.0.0.1:9";

const STARTUP_MS = 110_000;

describe("the built binary", () => {
  it("serves every agent tool over stdio and reports a dead RPC as a structured problem", async () => {
    const client = new Client({ name: "binary-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--url", UNREACHABLE], stderr: "pipe" }),
      { timeout: STARTUP_MS },
    );
    const { tools } = await client.listTools(undefined, { timeout: STARTUP_MS });
    expect(tools.map((t) => t.name)).toEqual(ACTIONS.map((a) => a.name));
    const result = await client.callTool({ name: "solive_get_config", arguments: {} }, { timeout: STARTUP_MS });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "Unreachable", retryable: true, hint: unreachableHint(UNREACHABLE) });
    await client.close();
  }, 120_000);

  it("refuses bad arguments with a usage error before serving", () => {
    const run = spawnSync(process.execPath, [bin, "mcp", "--keypair", "k.json"], { encoding: "utf8" });
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr.trim()).toBe("mcp does not take --keypair");
    expect(run.stdout).toBe("");
  }, 120_000);
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const AGENTS = readFileSync(`${ROOT}/docs/mcp.md`, "utf8");
const jsonBlocks = [...AGENTS.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");

async function served(args: string[]): Promise<string[]> {
  const client = new Client({ name: "docs-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" }));
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

const local = (args: string[]) => {
  const [yes, name, ...rest] = args;
  expect([yes, name]).toEqual(["-y", "@intent-engine/cli"]);
  return [bin, ...rest];
};

describe("the agent guide", () => {
  it("names a client entry that starts the server with every tool", async () => {
    const config = JSON.parse(jsonBlocks[0] ?? "") as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = config.mcpServers[PRODUCT_SLUG];
    expect(Object.keys(config.mcpServers)).toEqual([PRODUCT_SLUG]);
    expect(entry?.command).toBe("npx");
    expect(await served(local(entry?.args ?? []))).toEqual(ACTIONS.map((a) => a.name));
  }, 120_000);

  it("names agent arguments the server accepts", async () => {
    const { args } = JSON.parse(`{${jsonBlocks[1] ?? ""}}`) as { args: string[] };
    const dir = mkdtempSync(join(tmpdir(), "agent-"));
    const key = join(dir, "agent-keypair.json");
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const bytes = [...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")];
    expect(bytes).toHaveLength(64);
    writeFileSync(key, JSON.stringify(bytes));
    chmodSync(key, 0o600);
    const owner = (await generateKeyPairSigner()).address;
    const filled = local(args).map((a) => (a === "/path/to/agent-keypair.json" ? key : a === "OWNER_ADDRESS" ? owner : a));
    expect(filled).toContain(key);
    expect(filled).toContain(owner);
    expect(await served(filled)).toEqual(ACTIONS.map((a) => a.name));
  }, 120_000);

  it("holds no keys in the plain entry, so no tool it serves can send", async () => {
    expect(AGENTS).toContain(
      "With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction, and nothing moves until then.",
    );
    expect(ACTIONS.filter((a) => a.effect === "submit").map((a) => a.name)).toEqual([
      "solive_submit_signed_intent",
      "solive_agent_create",
    ]);
    const config = JSON.parse(jsonBlocks[0] ?? "") as { mcpServers: Record<string, { args: string[] }> };
    const client = new Client({ name: "docs-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: local(config.mcpServers[PRODUCT_SLUG]?.args ?? []), stderr: "pipe" }),
    );
    const owner = (await generateKeyPairSigner()).address;
    const order = { kind: "swap", amount_in: "10", min_out: "5" };
    const refused = await client.callTool({ name: "solive_agent_create", arguments: { owner, order, expires_in: 600 } });
    expect(refused.structuredContent).toMatchObject({ code: "AgentNotConfigured" });
    await client.close();
  }, 120_000);

  it("names only tools the server has, and the decimals get_balances returns", () => {
    const names = new Set(ACTIONS.map((a) => a.name));
    const named = [...AGENTS.matchAll(/`(solive_\w+)`/g)].map((m) => m[1] ?? "");
    expect(named.filter((n) => n !== "solive_" && !names.has(n))).toEqual([]);
    const balances = ACTIONS.find((a) => a.name === "solive_get_balances");
    expect(JSON.stringify(balances?.output.json)).toContain('"decimals"');
  });
});
