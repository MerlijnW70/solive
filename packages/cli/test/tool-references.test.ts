import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core";
import { EVERYDAY_TOOLS, servedActions } from "../src/agent/everyday.js";
import { ACTIONS } from "../src/agent/registry.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";
import { servedText, servedValue } from "../src/agent/mcp.js";

const AGENT = fileURLToPath(new URL("../src/agent", import.meta.url));
const NAMED = new RegExp(`\\b${PRODUCT_SLUG}_\\w+`, "g");
const CALLED = /tool\("([a-z_]+)"\)/g;
const DEFINED = /name: tool\("([a-z_]+)"\)/g;
const name = (short: string) => `${PRODUCT_SLUG}_${short}`;

const MODES = [
  { label: "no wallet", serving: { wallet: false, allTools: false, relay: false, agent: false } },
  { label: "wallet", serving: { wallet: true, allTools: false, relay: false, agent: false } },
  { label: "wallet, relay and agent", serving: { wallet: true, allTools: false, relay: true, agent: true } },
  { label: "wallet, all tools", serving: { wallet: true, allTools: true, relay: false, agent: false } },
];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );

const shortNames = (text: string, pattern: RegExp) => new Set([...text.matchAll(pattern)].map((m) => m[1] ?? ""));

describe("tool references", () => {
  for (const { label, serving } of MODES) {
    it(`names only served tools in every served definition: ${label}`, () => {
      const served = servedActions(serving);
      const names = new Set(served.map((action) => action.name));
      const stray = served.flatMap((action) =>
        [...[action.description, JSON.stringify(action.input.json), JSON.stringify(action.output.json)].join("\n").matchAll(NAMED)]
          .map(([found]) => found)
          .filter((found) => !names.has(found))
          .map((found) => `${action.name} names ${found}`),
      );
      expect(stray).toEqual([]);
    });
  }

  it("names only tools that exist anywhere in the agent source", () => {
    const defined = new Set([...WALLET_ACTIONS, ...ACTIONS].map((action) => action.name));
    const missing = sources(AGENT).flatMap((file) =>
      [...shortNames(readFileSync(file, "utf8"), CALLED)].filter((short) => !defined.has(name(short))).map((short) => `${file} names ${short}`),
    );
    expect(missing).toEqual([]);
  });

  it("points everyday wallet tools only at everyday tools", () => {
    const stray = sources(join(AGENT, "wallet")).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const defined = shortNames(text, DEFINED);
      if (![...defined].some((short) => EVERYDAY_TOOLS.has(name(short)))) {
        return [];
      }
      return [...shortNames(text, CALLED)]
        .filter((short) => !defined.has(short) && !EVERYDAY_TOOLS.has(name(short)))
        .map((short) => `${file} names ${short}`);
    });
    expect(stray).toEqual([]);
  });

  it("drops a hint clause that names a tool this server does not serve", () => {
    const names = new Set([name("wallet_receipt")]);
    expect(servedText(`announced; ${name("wallet_receipt")} shows when it is paid`, names)).toBe(`announced; ${name("wallet_receipt")} shows when it is paid`);
    expect(servedText(`released; ${name("wallet_feedback")} to rate`, names)).toBe("released");
    expect(servedText(`${name("agent_create")} was called on a server started without --agent`, new Set())).toBe(
      `${name("agent_create")} was called on a server started without --agent`,
    );
    expect(servedValue({ next: `a; ${name("x")} b`, warnings: [`c; ${name("x")}`], summary: [`d; ${name("x")}`] }, names)).toEqual({
      next: "a",
      warnings: ["c"],
      summary: [`d; ${name("x")}`],
    });
  });
});
