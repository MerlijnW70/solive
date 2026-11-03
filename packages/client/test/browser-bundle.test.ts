import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundled, NODE_MODULE, PACKAGES, packageDir, webOnly } from "./bundle.js";

const SMALL_BUDGET = 8_192;
const IDL = JSON.parse(readFileSync(join(PACKAGES, "core", "generated", "idl.json"), "utf8")) as { metadata: { name: string } };

const valuesOf = (name: string): string[] => [
  ...new Set(
    readFileSync(join(packageDir(name), "api-report.txt"), "utf8")
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

  it("caps replies in a browser bundle without a header the browser forbids", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(String(request.headers["accept-encoding"]));
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        const { id } = JSON.parse(body) as { id: unknown };
        response.writeHead(200, { "content-type": "application/json" }).end(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":"${"1".repeat(64)}"}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = "http://127.0.0.1:" + String((server.address() as AddressInfo).port);
      const app = [
        'import { createClient } from "@intent-engine/client";',
        "const real = fetch;",
        "const asked = [];",
        "globalThis.fetch = (to, init) => { asked.push(Object.keys(init.headers).sort()); return real(to, init); };",
        `const read = (cap) => createClient({ url: ${JSON.stringify(url)}, maxReplyBytes: cap }).transport.genesisHash().then((hash) => hash.length, (error) => error.name);`,
        "globalThis.done = Promise.all([read(4096), read(16)]).then((results) => ({ results, asked }));",
      ].join("\n");
      const { code } = await bundled(app);
      const done = await (webOnly(code)["done"] as Promise<unknown>);
      expect(done).toEqual({ results: [64, "ReplyTooLarge"], asked: [["accept", "content-type"], ["accept", "content-type"]] });
      expect(seen).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
