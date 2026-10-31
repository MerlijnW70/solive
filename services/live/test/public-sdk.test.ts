import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_SLUG } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { FAUCET_URL } from "../src/limits.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED = ["src", "api"];
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const HAND_BUILT = /\b(?:createDefaultRpcTransport|createSolanaRpcFromTransport|createSolanaRpc|rpcTransport\s*\()/;

const filesIn = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );

const specifiers = (text: string): string[] => [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? "");

const refused = (specifier: string): boolean => /(^|\/)internal(\/|$)/.test(specifier) || specifier.includes("packages/");

const findings = (files: readonly string[]) =>
  files.flatMap((file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    return [...specifiers(text).filter(refused).map((specifier) => `${file} imports ${specifier}`), ...(HAND_BUILT.test(text) ? [`${file} builds its own transport`] : [])];
  });

describe("the feed reads through the public SDK only", () => {
  it("imports no /internal entry and builds no transport of its own in src or api", () => {
    const files = SHIPPED.flatMap(filesIn);
    expect(files.length).toBeGreaterThan(10);
    expect(findings(files)).toEqual([]);
  });

  it("names the product only through the public export, never as a literal", () => {
    const named = SHIPPED.flatMap(filesIn).filter((file) => readFileSync(join(ROOT, file), "utf8").toLowerCase().includes(PRODUCT_SLUG));
    expect(named).toEqual([]);
    expect(FAUCET_URL).toContain(PRODUCT_SLUG + "-faucet");
  });

  it("catches every form of a refused import", () => {
    const forms = [
      'import { x } from "@intent-engine/core/internal";',
      "import type { Y } from '@intent-engine/client/internal';",
      'export { z } from "@intent-engine/client/internal";',
      'const m = await import("@intent-engine/core/internal");',
      'import { w } from "../../../packages/core/src/index.js";',
    ];
    for (const form of forms) {
      expect(specifiers(form).some(refused), form).toBe(true);
    }
    expect(specifiers('import { createClient } from "@intent-engine/client";').some(refused)).toBe(false);
    expect(specifiers('import { Kind } from "@intent-engine/core";').some(refused)).toBe(false);
    expect(HAND_BUILT.test("const t = createDefaultRpcTransport({ url });")).toBe(true);
    expect(HAND_BUILT.test("readerOf(createClient({ url }))")).toBe(false);
  });
});
