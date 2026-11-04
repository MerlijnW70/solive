import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { servedActions } from "../src/agent/everyday.js";
import { ACTIONS } from "../src/agent/registry.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(join(ROOT, "docs/reference/mcp-tools.md"), "utf8");
const intro = PAGE.split("\n").find((line) => line.startsWith("This page lists ")) ?? "";
const none = { wallet: false, allTools: false, relay: false, agent: false };

describe("the MCP tools reference", () => {
  it("states the counts of the lists the server serves", () => {
    const every = servedActions({ ...none, wallet: true, allTools: true });
    const everyday = servedActions({ ...none, wallet: true });
    expect(intro).toContain(`This page lists ${every.length} tools: ${WALLET_ACTIONS.length} wallet tools and ${ACTIONS.length} others.`);
    expect(intro).toContain(`serves the ${servedActions(none).length} others over stdio`);
    expect(intro).toContain(`it serves only the ${everyday.length} everyday tools: `);
    expect(intro).toContain(`it serves all ${every.length}, the ${WALLET_ACTIONS.length} wallet tools listed first`);
  });

  it("lists as many tools as it counts, and exactly the everyday ones in its everyday list", () => {
    const headings = PAGE.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(servedActions({ ...none, wallet: true, allTools: true }).map((action) => `## ${action.name}`));
    const everyday = /everyday tools: (.*), plus the tools/.exec(intro)?.[1]?.split(", ").map((name) => name.replaceAll("`", ""));
    expect(everyday).toEqual(servedActions({ ...none, wallet: true }).map((action) => action.name));
  });
});
