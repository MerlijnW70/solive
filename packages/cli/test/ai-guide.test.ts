import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLUSTERS, parse } from "../src/args.js";
import { PREVIEW_ONLY, WALLET_ACTIONS } from "../src/agent/wallet.js";
import { tool } from "../src/agent/names.js";
import { NATIVE_MINT } from "../src/tokens.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/ai.md");
const manifest = JSON.parse(read("packages/cli/package.json")) as { name: string; bin: Record<string, string>; engines: { node: string } };
const ARGS = ["-y", manifest.name, "mcp", "--url", "devnet", "--wallet"];
const EXPLORER_MCP = "https://explorer.solana.com/mcp";
const sh = [...PAGE.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => (m[1] ?? "").trim());
const json = [...PAGE.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => (m[1] ?? "").trim());

describe("the AI guide", () => {
  it("installs the published server the same way in every app, and the server takes those arguments", () => {
    expect(Object.keys(manifest.bin)).toHaveLength(1);
    const [claude, codex, code, limited, ...explorer] = sh;
    expect(sh).toHaveLength(7);
    expect(explorer).toEqual([
      `claude mcp add --transport http solana-explorer ${EXPLORER_MCP}`,
      `codex mcp add solana-explorer --url ${EXPLORER_MCP}`,
      `code --add-mcp '${JSON.stringify({ name: "solana-explorer", type: "http", url: EXPLORER_MCP })}'`,
    ]);
    expect(claude).toBe(`claude mcp add solive -- npx ${ARGS.join(" ")}`);
    expect(codex).toBe(`codex mcp add solive -- npx ${ARGS.join(" ")}`);
    const added = /^code --add-mcp '(.*)'$/.exec(code ?? "")?.[1] ?? "";
    expect(JSON.parse(added)).toEqual({ name: "solive", command: "npx", args: ARGS });
    expect(json.map((j) => JSON.parse(j))).toEqual([{ mcpServers: { solive: { command: "npx", args: ARGS } } }]);
    expect(parse(ARGS.slice(2), {})).toMatchObject({ name: "mcp", url: CLUSTERS["devnet"], wallet: { perTrade: new Map(), perHour: new Map() } });
    const limits = ["--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.5"];
    expect(limited).toBe(`${claude} ${limits.join(" ")}`);
    expect(parse([...ARGS.slice(2), ...limits], {})).toMatchObject({
      wallet: { perTrade: new Map([[NATIVE_MINT, "0.1"]]), perHour: new Map([[NATIVE_MINT, "0.5"]]) },
    });
    const [, major, minor] = /^>=(\d+)\.(\d+)\.0$/.exec(manifest.engines.node) ?? [];
    expect(PAGE).toContain(`You need Node.js ${major}.${minor} or later.`);
  });

  it("promises nothing is sent before the user approves, as the wallet tools answer", () => {
    expect(PAGE).toContain("It swaps, auctions or cancels nothing until you say yes.");
    expect(WALLET_ACTIONS.map((a) => a.name)).toContain(tool("wallet_auction"));
    expect(PREVIEW_ONLY.startsWith("nothing was sent")).toBe(true);
  });
});
