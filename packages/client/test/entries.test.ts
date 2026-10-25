import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { graph } from "./import-graph.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIT = "@solana/kit";
const WEB_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  core: [KIT, "@solana-program/token"],
  client: [KIT, "@solana-program/token", "@solana-program/system", "@intent-engine/core"],
};

type Entry = { types: string; import: string; default: string };
type Manifest = {
  sideEffects?: boolean;
  exports: Record<string, Entry>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const manifestOf = (name: string): Manifest => JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as Manifest;
const src = (name: string, file: string) => join(PACKAGES, name, "src", file);
const entry = (file: string): Entry => ({ types: `./dist/src/${file}.d.ts`, import: `./dist/src/${file}.js`, default: `./dist/src/${file}.js` });

describe("the package entry points", () => {
  it.each(["core", "client"])("declare %s free of side effects, with kit a peer in the range it supports and a dev dependency here", (name) => {
    const manifest = manifestOf(name);
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.dependencies[KIT]).toBeUndefined();
    expect(manifest.devDependencies[KIT]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.peerDependencies[KIT]).toBe(`^${manifest.devDependencies[KIT]}`);
  });

  it("export the client's node and internal entries and core's internal entry", () => {
    expect(manifestOf("client").exports["./node"]).toEqual(entry("node"));
    expect(manifestOf("client").exports["./internal"]).toEqual(entry("internal"));
    expect(manifestOf("core").exports["./internal"]).toEqual(entry("internal"));
  });

  it.each([
    ["core", "index.ts"],
    ["core", "internal.ts"],
    ["client", "index.ts"],
  ])("reach from %s %s no node: module and only packages that run in a browser", (name, file) => {
    const reached = graph(src(name, file));
    expect([...reached.specifiers].filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    expect([...reached.packages].filter((found) => !(WEB_PACKAGES[name] ?? []).includes(found))).toEqual([]);
  });

  it("keep pinned fetch, the system lookup and Ledger signing in the node entry", () => {
    const root = graph(src("client", "index.ts")).modules;
    const node = graph(src("client", "node.ts"));
    for (const file of ["pinned-fetch.ts", "public-host.ts", "ledger.ts"]) {
      expect([...root].some((found) => found.endsWith(`/${file}`) || found.endsWith(`\\${file}`))).toBe(false);
      expect([...node.modules].some((found) => found.endsWith(`/${file}`) || found.endsWith(`\\${file}`))).toBe(true);
    }
    expect([...node.specifiers].filter((specifier) => specifier.startsWith("node:")).sort()).toEqual(["node:crypto", "node:dns/promises", "node:http", "node:https", "node:module", "node:net", "node:stream", "node:zlib"]);
  });
});
