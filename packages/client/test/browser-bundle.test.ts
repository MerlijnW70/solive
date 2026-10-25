import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundled, NODE_MODULE, PACKAGES, webOnly } from "./bundle.js";

const SMALL_BUDGET = 8_192;
const IDL = JSON.parse(readFileSync(join(PACKAGES, "core", "generated", "idl.json"), "utf8")) as { metadata: { name: string } };

const valuesOf = (name: string): string[] => [
  ...new Set(
    readFileSync(join(PACKAGES, name, "api-report.txt"), "utf8")
      .split("\n")
      .map((line) => /^(\w+) ([\w$]+):/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null && m[1] !== "type" && m[1] !== "interface")
      .map((m) => m[2] ?? ""),
  ),
].sort();

describe("the client root in a browser bundle", () => {
  it("bundles for the browser with nothing external, names no node: module, holds no IDL and runs with only web globals", async () => {
    const app = [
      'import { createClient } from "@intent-engine/client";',
      'import { parseAmount } from "@intent-engine/core";',
      'const client = createClient({ url: "https://api.devnet.solana.com" });',
      'globalThis.made = { url: client.url, watches: typeof client.watch, amount: String(parseAmount("1.5", 9)) };',
    ].join("\n");
    const { code, inputs } = await bundled(app);
    expect(code).not.toMatch(NODE_MODULE);
    expect(inputs.filter((input) => input.startsWith("node:") || input.endsWith(".json"))).toEqual([]);
    expect(code).not.toContain(IDL.metadata.name);
    expect(webOnly(code)["made"]).toEqual({ url: "https://api.devnet.solana.com", watches: "function", amount: "1500000000" });
  });

  it("loads every value both api reports list with only web globals", async () => {
    const app = [
      'import * as client from "@intent-engine/client";',
      'import * as core from "@intent-engine/core";',
      "globalThis.names = { client: Object.keys(client).sort(), core: Object.keys(core).sort() };",
    ].join("\n");
    const { code, inputs } = await bundled(app);
    expect(code).not.toMatch(NODE_MODULE);
    expect(inputs.filter((input) => input.endsWith(".json"))).toEqual([]);
    expect(webOnly(code)["names"]).toEqual({ client: valuesOf("client"), core: valuesOf("core") });
  });

  it(`keeps a bundle of one small helper under ${SMALL_BUDGET} bytes`, async () => {
    const { code } = await bundled('import { isSdkError } from "@intent-engine/client";\nglobalThis.checked = isSdkError(new Error("plain"));');
    expect(code.length).toBeLessThan(SMALL_BUDGET);
    expect(webOnly(code)["checked"]).toBe(false);
  });

  it("fails the build for a node: import, since nothing is external and nothing is polyfilled", async () => {
    await expect(bundled('import "node:fs";\nimport { createClient } from "@intent-engine/client";\nglobalThis.made = createClient;')).rejects.toThrow(/node:fs/);
  });
});
