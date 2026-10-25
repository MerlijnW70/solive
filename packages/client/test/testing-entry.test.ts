import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_PROGRAM_FILE } from "../src/testing.js";
import { graph, IMPORT } from "./import-graph.js";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE, "src");

type Manifest = {
  files: string[];
  exports: Record<string, { types: string; import: string; default: string }>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Manifest;

describe("the testing entry point", () => {
  it("is exported beside svm, and the package files carry the engine program", () => {
    expect(manifest.exports["./testing"]).toEqual({ types: "./dist/src/testing.d.ts", import: "./dist/src/testing.js", default: "./dist/src/testing.js" });
    expect(manifest.exports["./svm"]?.import).toBe("./dist/src/svm.js");
    expect(manifest.files).toContain(ENGINE_PROGRAM_FILE);
  });

  it("keeps litesvm an optional peer that only the svm and testing entry points load, never the client root", () => {
    expect(manifest.dependencies["litesvm"]).toBeUndefined();
    expect(manifest.peerDependencies["litesvm"]).toBeDefined();
    expect(manifest.peerDependenciesMeta["litesvm"]).toEqual({ optional: true });
    const root = graph(join(SRC, "index.ts"));
    expect(root.modules.size).toBeGreaterThan(40);
    expect(root.packages.has("litesvm")).toBe(false);
    expect([...root.modules].filter((file) => file.endsWith("svm.ts") || file.endsWith("testing.ts"))).toEqual([]);
    expect(graph(join(SRC, "testing.ts")).packages.has("litesvm")).toBe(true);
    expect(graph(join(SRC, "svm.ts")).packages.has("litesvm")).toBe(true);
  });

  it("follows static, re-exported and dynamic imports", () => {
    const found = [...'import { a } from "./a.js";\nexport { b } from "@scope/b/deep";\nconst c = await import("c/x");'.matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
    expect(found).toEqual(["./a.js", "@scope/b/deep", "c/x"]);
  });
});
