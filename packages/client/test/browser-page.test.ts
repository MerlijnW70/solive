import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kind } from "@intent-engine/core";
import * as root from "../src/index.js";
import { createClient, SpecUnreadable, type SpecFetch } from "../src/index.js";
import { MAX_SPEC_BYTES } from "../src/internal.js";
import { NOT_PUBLIC_SPEC } from "../src/job-specs.js";
import * as node from "../src/node.js";
import { bundled, NODE_MODULE, PACKAGES, WEB_GLOBALS, webOnly } from "./bundle.js";
import { BROWSER_SECTION } from "./doc-sections.js";
import { graph } from "./import-graph.js";
import { funded, world, type World } from "./svm.js";

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host === "inside.example" ? "10.1.1.1" : "93.184.215.14", family: 4 }],
}));

const PAGE = readFileSync(join(PACKAGES, "..", "docs", "sdk-client.md"), "utf8");
const SECTION = BROWSER_SECTION.exec(PAGE)?.[0] ?? "";
const SPEC = "the spec a browser reads\n";
const REMOTE = "https://" + "rpc.example";
const LOCAL = "http://" + "127.0.0.1:8899";
const DEVNET_RPC = "https://" + "api.devnet.solana.com";

const CLAIMS = {
  roots:
    "The roots of `@intent-engine/core` and `@intent-engine/client` import no Node module, so a bundler builds them for the browser without polyfills, and an app that imports one helper bundles only that helper and what it uses.",
  page: "`createClient` and `connect` run in a page that offers only `fetch`, `crypto`, `TextEncoder`, `TextDecoder`, `URL` and `console`.",
  node: "`createClient` and `connect` from `@intent-engine/client/node` check every address a spec host resolves to and connect only to those; the Node entry also holds Ledger signing, `ledgerSigner` and `openUsb`.",
  svm: "`@intent-engine/client/svm` and `@intent-engine/client/testing` run in Node only.",
  fetch: "Without the Node entry, `spec` fetches with the global `fetch`, follows no redirect and reads at most 1048576 bytes.",
  literal:
    "It refuses a url whose host is written as a private, link-local or loopback address, or is a `localhost` name, unless the RPC url is loopback or the transport is `offline`; it cannot check where a host name resolves.",
  hash: 'A page hashes a spec with web crypto: `new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))` is the 32-byte `specHash` of the spec `text`.',
  lookup: "Pass `lookup`, a function from a host name to its addresses, to check them all; the `fetch` you pass then receives the checked `addresses`.",
  internal:
    "`@intent-engine/client/internal` and `@intent-engine/core/internal` hold what the CLI, the solver and the tests share; they carry no stability promise and change in any release.",
};

const ELSEWHERE = {
  connect: "In Node, import it from `@intent-engine/client/node`, as here, so spec fetches keep their address checks.",
  less: "Without the Node entry it checks less, as [In a browser](#in-a-browser) says.",
  handed: "A `fetch` you pass to `createClient` is handed the checked `addresses` of the host whenever the client checked them, and must connect only to them.",
};

type Asked = { url: string; addresses: readonly string[] | undefined };

const serving =
  (asked: Asked[]): SpecFetch =>
  async (url, init) => {
    asked.push({ url, addresses: init.addresses });
    return new Response(SPEC);
  };

async function escrow(w: World, specUrl: string): Promise<Address> {
  const judge = await funded(w.chain);
  const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const made = await createClient({ url: LOCAL, transport: w.chain.transport }).createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params, specUrl });
  return made.intent;
}

const files = (found: Set<string>) => [...found].map((file) => file.replaceAll("\\", "/").split("/").pop());

describe("the In a browser section of the client page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("states exactly the claims these tests assert", () => {
    const [intro = ""] = SECTION.split("\n").filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("- "));
    expect([intro, ...[...SECTION.matchAll(/^- (.+)$/gm)].map((m) => m[1])]).toEqual(Object.values(CLAIMS));
    for (const sentence of Object.values(ELSEWHERE)) {
      expect(PAGE).toContain(sentence);
    }
  });

  it(CLAIMS.roots, async () => {
    for (const [name, file] of [
      ["core", "index.ts"],
      ["core", "internal.ts"],
      ["client", "index.ts"],
    ] as const) {
      expect([...graph(join(PACKAGES, name, "src", file)).specifiers].filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    }
    const whole = await bundled('import * as client from "@intent-engine/client";\nimport * as core from "@intent-engine/core";\nglobalThis.both = [client, core];');
    const helper = await bundled('import { isSdkError } from "@intent-engine/client";\nglobalThis.helper = isSdkError;');
    expect(whole.code).not.toMatch(NODE_MODULE);
    expect(helper.code.length * 10).toBeLessThan(whole.code.length);
  });

  it(CLAIMS.page, async () => {
    expect(CLAIMS.page).toContain(WEB_GLOBALS.slice(0, -1).map((name) => `\`${name}\``).join(", "));
    const app = [
      'import { address, createNoopSigner } from "@solana/kit";',
      'import { connect, createClient } from "@intent-engine/client";',
      'const transport = { genesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" };',
      "globalThis.done = (async () => {",
      `  const client = createClient({ url: ${JSON.stringify(DEVNET_RPC)} });`,
      '  const solive = await connect({ cluster: "devnet", signer: createNoopSigner(address("11111111111111111111111111111111")), transport });',
      "  return [typeof client.intents, typeof solive.swap, solive.client.url];",
      "})();",
    ].join("\n");
    const { code } = await bundled(app);
    expect(await (webOnly(code)["done"] as Promise<unknown>)).toEqual(["function", "function", DEVNET_RPC]);
  });

  it(CLAIMS.node, async () => {
    const w = await world();
    const url = "https://" + "spec.example/spec.md";
    const intent = await escrow(w, url);
    const asked: Asked[] = [];
    const checked = (url: string, init: { addresses: readonly string[] }) => serving(asked)(url, { redirect: "error", signal: AbortSignal.timeout(1_000), addresses: init.addresses });
    expect(await node.createClient({ url: REMOTE, transport: w.chain.transport, fetch: checked }).spec(intent)).toMatchObject({ url, matches: true });
    const solive = await node.connect({ url: REMOTE, signer: w.owner, transport: w.chain.transport, fetch: checked, allowMainnet: true });
    expect(await solive.client.spec(intent)).toMatchObject({ url, matches: true });
    expect(asked).toEqual([
      { url, addresses: ["93.184.215.14"] },
      { url, addresses: ["93.184.215.14"] },
    ]);
    const inside = "https://" + "inside.example/spec.md";
    const refused = await escrow(w, inside);
    await expect(node.createClient({ url: REMOTE, transport: w.chain.transport, fetch: checked }).spec(refused)).rejects.toThrow(new SpecUnreadable(inside, NOT_PUBLIC_SPEC));
    expect(asked).toHaveLength(2);
    for (const name of ["ledgerSigner", "openUsb", "pinnedFetch", "systemLookup"]) {
      expect(name in node).toBe(true);
      expect(name in root).toBe(false);
    }
  });

  it(CLAIMS.svm, () => {
    for (const file of ["svm.ts", "testing.ts"]) {
      const reached = graph(join(PACKAGES, "client", "src", file));
      expect(reached.packages.has("litesvm")).toBe(true);
      expect([...reached.specifiers].some((specifier) => specifier.startsWith("node:"))).toBe(true);
    }
  });

  it(CLAIMS.fetch, async () => {
    expect(MAX_SPEC_BYTES).toBe(1_048_576);
    const w = await world();
    const url = "https://" + "spec.example/spec.md";
    const large = "https://" + "spec.example/large.md";
    const [intent, oversized] = [await escrow(w, url), await escrow(w, large)];
    const global = vi.fn(async (asked: string, _init?: RequestInit) => (asked === large ? new Response("x", { headers: { "content-length": String(MAX_SPEC_BYTES + 1) } }) : new Response(SPEC)));
    vi.stubGlobal("fetch", global);
    const client = createClient({ url: REMOTE, transport: w.chain.transport });
    expect(await client.spec(intent)).toMatchObject({ url, text: SPEC, matches: true });
    await expect(client.spec(oversized)).rejects.toThrow(new SpecUnreadable(large, `is larger than ${MAX_SPEC_BYTES} bytes`));
    expect(global.mock.calls.map(([asked, init]) => [asked, init?.redirect])).toEqual([
      [url, "error"],
      [large, "error"],
    ]);
  });

  it(CLAIMS.literal, async () => {
    const w = await world();
    for (const host of ["10.0.0.7", "169.254.169.254", "[fd00::1]", "[fe80::1]", "127.0.0.1", "[::1]", "localhost", "spec.localhost"]) {
      const url = "https://" + host + "/spec.md";
      const intent = await escrow(w, url);
      const asked: Asked[] = [];
      await expect(createClient({ url: REMOTE, transport: w.chain.transport, fetch: serving(asked) }).spec(intent)).rejects.toThrow(new SpecUnreadable(url, NOT_PUBLIC_SPEC));
      expect(asked).toEqual([]);
    }
    const v = await world();
    for (const host of ["127.0.0.1:8443", "localhost:8443"]) {
      const url = "https://" + host + "/spec.md";
      const asked: Asked[] = [];
      expect(await createClient({ url: LOCAL, transport: v.chain.transport, fetch: serving(asked) }).spec(await escrow(v, url))).toMatchObject({ url, matches: true });
      expect(asked).toHaveLength(1);
    }
    for (const host of ["127.0.0.1:8443", "localhost:8443"]) {
      const url = "https://" + host + "/spec.md";
      const asked: Asked[] = [];
      const offline = { ...v.chain.transport, offline: true };
      expect(await createClient({ url: REMOTE, transport: offline, fetch: serving(asked) }).spec(await escrow(v, url))).toMatchObject({ url, matches: true });
      expect(asked).toHaveLength(1);
    }
    const named = "https://" + "inside.example/spec.md";
    const asked: Asked[] = [];
    expect(await createClient({ url: REMOTE, transport: v.chain.transport, fetch: serving(asked) }).spec(await escrow(v, named))).toMatchObject({ url: named, matches: true });
    expect(asked).toEqual([{ url: named, addresses: undefined }]);
  });

  it(CLAIMS.hash, async () => {
    const expression = /`(new Uint8Array\(await crypto\.subtle[^`]+)`/.exec(CLAIMS.hash)?.[1] ?? "";
    const hashed = (await new Function("text", `return (async () => ${expression})();`)(SPEC)) as Uint8Array;
    expect(hashed).toBeInstanceOf(Uint8Array);
    expect(hashed).toEqual(new Uint8Array(createHash("sha256").update(SPEC).digest()));
    expect(WEB_GLOBALS).toContain("crypto");
    expect(WEB_GLOBALS).toContain("TextEncoder");
    const w = await world();
    const url = "https://" + "spec.example/spec.md";
    const judge = await funded(w.chain);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: hashed, judgeFee: 0n } as const;
    const made = await createClient({ url: LOCAL, transport: w.chain.transport }).createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params, specUrl: url });
    vi.stubGlobal("fetch", async () => new Response(SPEC));
    expect(await createClient({ url: REMOTE, transport: w.chain.transport }).spec(made.intent)).toMatchObject({ matches: true });
  });

  it(CLAIMS.lookup, async () => {
    const w = await world();
    const url = "https://" + "spec.example/spec.md";
    const intent = await escrow(w, url);
    const asked: Asked[] = [];
    const answering = (addresses: string[]) => async (host: string) => (host === "spec.example" ? addresses : []);
    expect(await createClient({ url: REMOTE, transport: w.chain.transport, fetch: serving(asked), lookup: answering(["93.184.215.14", "2606:2800:21f:cb07::1"]) }).spec(intent)).toMatchObject({ matches: true });
    expect(asked).toEqual([{ url, addresses: ["93.184.215.14", "2606:2800:21f:cb07::1"] }]);
    await expect(createClient({ url: REMOTE, transport: w.chain.transport, fetch: serving(asked), lookup: answering(["93.184.215.14", "10.0.0.1"]) }).spec(intent)).rejects.toThrow(
      new SpecUnreadable(url, NOT_PUBLIC_SPEC),
    );
    expect(asked).toHaveLength(1);
  });

  it(CLAIMS.internal, () => {
    for (const name of ["core", "client"]) {
      const manifest = JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as { exports: Record<string, unknown> };
      expect(manifest.exports["./internal"]).toBeDefined();
    }
    expect(readFileSync(join(PACKAGES, "..", "scripts", "api-report.mjs"), "utf8")).toContain('const ENTRY = "dist/src/index.d.ts";');
    for (const [name, entries] of [
      ["cli", ["@intent-engine/client/internal", "@intent-engine/core/internal"]],
      ["solver", ["@intent-engine/core/internal"]],
    ] as const) {
      const reached = graph(join(PACKAGES, name, "src", name === "cli" ? "main.ts" : "index.ts"));
      for (const entry of entries) {
        expect(reached.specifiers.has(entry)).toBe(true);
      }
    }
    expect(files(graph(join(PACKAGES, "client", "src", "index.ts")).modules)).not.toContain("internal.ts");
  });

  it(ELSEWHERE.handed, async () => {
    const w = await world();
    const url = "https://" + "spec.example/spec.md";
    const intent = await escrow(w, url);
    const asked: Asked[] = [];
    await createClient({ url: REMOTE, transport: w.chain.transport, fetch: serving(asked) }).spec(intent);
    await createClient({ url: REMOTE, transport: w.chain.transport, fetch: serving(asked), lookup: async () => ["93.184.215.14"] }).spec(intent);
    expect(asked).toEqual([
      { url, addresses: undefined },
      { url, addresses: ["93.184.215.14"] },
    ]);
    expect(PAGE).toContain('import { createClient } from "@intent-engine/client/node";');
  });
});

