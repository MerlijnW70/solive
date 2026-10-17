import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT, PRODUCT_REPOSITORY, PRODUCT_SLUG } from "@intent-engine/core";
import { CLUSTERS, parse } from "../src/args.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const SKILL_DIR = "examples/openclaw/intent-engine";
const SKILL = read(`${SKILL_DIR}/SKILL.md`);
const GUIDE = read("docs/openclaw.md");
const CONFIG = read("examples/openclaw/openclaw.json5");
const REFERENCE = read("docs/reference/mcp-tools.md");
const manifest = JSON.parse(read("packages/cli/package.json")) as { name: string; version: string };
const SERVER = "intent";
const RULES = [
  "Never call any tool with `send: true` until the user said yes to the summary just shown.",
  "Devnet only.",
  "Never ask for, print or move a private key.",
];

type Server = { command: string; args: string[]; requestTimeoutMs: number };
type Config = { mcp: { servers: Record<string, Server> } };

const fenced = (text: string, language: string) => [...text.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map((m) => (m[1] ?? "").trim());

function frontMatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

const served = (server: Server | undefined) => {
  const args = server?.args ?? [];
  expect(server?.command).toBe("npx");
  expect(args.slice(0, 3)).toEqual(["-y", `${manifest.name}@${manifest.version}`, "mcp"]);
  return parse(args.slice(2), {});
};

describe("the openclaw guide and skill", () => {
  it("the openclaw skill names only real tools and pins the current version", () => {
    const meta = frontMatter(SKILL);
    expect(Object.keys(meta)).toEqual(["name", "description", "homepage", "metadata"]);
    expect(meta["name"]).toBe("intent-engine");
    expect(meta["description"]?.length).toBeGreaterThan(20);
    expect(meta["homepage"]).toBe(PRODUCT_REPOSITORY);
    expect(JSON.parse(meta["metadata"] ?? "")).toEqual({ openclaw: { requires: { bins: ["npx"] } } });

    const real = new Set([...REFERENCE.matchAll(/^## (\S+)$/gm)].map((m) => m[1] ?? ""));
    expect(real.size).toBeGreaterThan(30);
    const named = (text: string) => [...text.matchAll(new RegExp(`(?<![a-z])${PRODUCT_SLUG}_[a-z_]*[a-z](?![a-z_*])`, "g"))].map((m) => m[0]);
    const prefixed = (text: string) => [...text.matchAll(new RegExp(`\\b(\\w+)__(${PRODUCT_SLUG}_\\w*)`, "g"))].map((m) => m[1] ?? "");
    for (const text of [SKILL, GUIDE]) {
      expect(named(text).filter((name) => !real.has(name))).toEqual([]);
      expect(new Set(prefixed(text))).toEqual(new Set([SERVER]));
    }
    const flows = [
      "find_jobs", "wallet_deliver", "wallet_check_delivery", "wallet_receipt",
      "wallet_escrow_plan", "wallet_escrow", "wallet_attest", "wallet_attest_split",
      "wallet_estimate", "wallet_swap", "wallet_wait",
    ].map((t) => `${SERVER}__${PRODUCT_SLUG}_${t}`);
    expect(flows.filter((t) => !SKILL.includes(`\`${t}\``))).toEqual([]);

    const pins = (text: string) => [...text.matchAll(new RegExp(`${manifest.name}@([^"\\s]+)`, "g"))].map((m) => m[1]);
    expect(pins(GUIDE)).toEqual([manifest.version, manifest.version]);
    expect(pins(CONFIG)).toEqual([manifest.version]);
    expect(pins(SKILL)).toEqual([]);

    const config = JSON.parse(CONFIG) as Config;
    const [entry, readOnly, deny] = fenced(GUIDE, "json5").map((block) => JSON.parse(block) as Record<string, unknown>);
    expect(entry).toEqual(config);
    expect(Object.keys(config.mcp.servers)).toEqual([SERVER]);
    const wallet = config.mcp.servers[SERVER];
    expect(wallet?.requestTimeoutMs).toBeGreaterThan(40_000);
    expect(served(wallet)).toMatchObject({
      name: "mcp",
      url: CLUSTERS["devnet"],
      wallet: { perTrade: new Map([[NATIVE_MINT, "0.1"]]), perHour: new Map([[NATIVE_MINT, "0.5"]]) },
    });
    const discover = (readOnly as Config | undefined)?.mcp.servers[SERVER];
    expect(discover?.requestTimeoutMs).toBe(wallet?.requestTimeoutMs);
    expect(served(discover)).toMatchObject({ name: "mcp", url: CLUSTERS["devnet"], wallet: null });

    const rule = (deny as { agents: { list: { tools: { deny: string[] } }[] } } | undefined)?.agents.list[0]?.tools.deny ?? [];
    expect(rule).toEqual([`${SERVER}__${PRODUCT_SLUG}_wallet_*`]);
    const glob = new RegExp(`^${(rule[0] ?? "").replace("*", ".*")}$`);
    expect(WALLET_ACTIONS.filter((a) => !glob.test(`${SERVER}__${a.name}`))).toEqual([]);
    expect(GUIDE).toContain("`command` may need to be `npx.cmd`");
  });

  it("the openclaw skill carries the safety rules and no scripts", () => {
    const rules = SKILL.slice(SKILL.indexOf("## Rules"), SKILL.indexOf("## Earn"));
    expect(rules.trim().split("\n").slice(2)).toEqual(RULES.map((r) => `- ${r}`));
    expect(readdirSync(`${ROOT}/${SKILL_DIR}`)).toEqual(["SKILL.md"]);
    expect(readdirSync(`${ROOT}/examples/openclaw`).sort()).toEqual(["intent-engine", "openclaw.json5"]);
    expect(SKILL).not.toContain("```");

    const download = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|iex)\b/i;
    const pipe = /\|\s*(ba|z)?sh\b|\|\s*(iex|node|python)\b/i;
    for (const text of [SKILL, GUIDE, CONFIG]) {
      expect(text).not.toMatch(download);
      expect(text).not.toMatch(pipe);
    }
    const commands = [...fenced(GUIDE, "sh"), ...fenced(GUIDE, "powershell")].flatMap((block) => block.split("\n"));
    expect(commands).toEqual([`openclaw mcp configure ${SERVER} --approval prompt`]);
    expect(fenced(GUIDE, "[a-z0-9]+").length).toBe(fenced(GUIDE, "json5").length + commands.length);
    expect(GUIDE).toContain(`Never answer "Allow Always" for an \`${SERVER}__${PRODUCT_SLUG}_wallet_*\` tool.`);
    expect(GUIDE).toContain("`send: true` included");
  });
});
