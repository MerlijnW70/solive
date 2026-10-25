import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "api-report.mjs");
const LINT = readFileSync(join(ROOT, "scripts", "lint.sh"), "utf8");

const CORE = [
  'export { type Amount, parseAmount } from "./describe.js";',
  'export { SdkError } from "./errors.js";',
].join("\n");
const CORE_FILES: Record<string, string> = {
  "describe.d.ts": "export type Amount = bigint;\nexport declare function parseAmount(text: string, decimals: number): Amount;\nexport declare function hidden(): void;\n",
  "errors.d.ts": "declare const BRAND: unique symbol;\nexport declare abstract class SdkError extends Error {\n  readonly [BRAND] = true;\n}\n",
};
const CLIENT = 'export { createClient, type Client } from "./client.js";\nexport { SdkError } from "@intent-engine/core";\n';
const CLIENT_FILES: Record<string, string> = {
  "client.d.ts": 'import type { Amount } from "@intent-engine/core";\nexport type Client = {\n  url: string;\n  amount(text: string): Promise<Amount>;\n};\nexport declare function createClient(url: string): Client;\n',
};

let made: string | null = null;

function tree(core = CORE, client = CLIENT, clientFiles = CLIENT_FILES): string {
  const root = mkdtempSync(join(tmpdir(), "api-report-"));
  made = root;
  const place = (name: string, index: string, files: Record<string, string>) => {
    const dir = join(root, "packages", name, "dist", "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.d.ts"), index);
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, file), text);
    }
  };
  place("core", core, CORE_FILES);
  place("client", client, clientFiles);
  return root;
}

const report = (root: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

const reportOf = (root: string, name: string) => readFileSync(join(root, "packages", name, "api-report.txt"), "utf8");

describe("the api report of each package root", () => {
  afterEach(() => {
    if (made !== null) {
      rmSync(made, { recursive: true, force: true });
      made = null;
    }
  });

  it("matches the exports of the built roots of core and client, and lint checks it after the builds", () => {
    expect(report(ROOT)).toEqual({ status: 0, out: "api report check passed: @intent-engine/core, @intent-engine/client\n" });
    const steps = LINT.split("\n");
    expect(steps.indexOf("bash scripts/api-report.sh")).toBeGreaterThan(steps.indexOf("pnpm --filter @intent-engine/client build"));
  });

  it("lists every exported name with its kind and signature", () => {
    const root = tree();
    expect(report(root, "--write").status).toBe(0);
    expect(reportOf(root, "core")).toBe(
      [
        "type Amount: type Amount = bigint;",
        "class SdkError: abstract class SdkError extends Error { readonly [BRAND] = true; }",
        "function parseAmount: function parseAmount(text: string, decimals: number): Amount;",
        "",
      ].join("\n"),
    );
    expect(reportOf(root, "client")).toBe(
      [
        "type Client: type Client = { url: string; amount(text: string): Promise<Amount>; };",
        "class SdkError: abstract class SdkError extends Error { readonly [BRAND] = true; }",
        "function createClient: function createClient(url: string): Client;",
        "",
      ].join("\n"),
    );
    expect(report(root).status).toBe(0);
  });

  it("fails when a root exports a name its committed report does not list", () => {
    const root = tree();
    report(root, "--write");
    writeFileSync(join(root, "packages", "core", "dist", "src", "index.d.ts"), `${CORE}\nexport { hidden } from "./describe.js";\n`);
    const checked = report(root);
    expect(checked.status).toBe(1);
    expect(checked.out).toContain("the exports of @intent-engine/core differ from packages/core/api-report.txt:\n  + function hidden: function hidden(): void;");
  });

  it("fails when a root signature names a type no package root exports", () => {
    const leaking = { "client.d.ts": "type Hidden = { url: string };\nexport declare function createClient(url: string): Hidden;\nexport type Client = Hidden;\n" };
    const root = tree(CORE, CLIENT, leaking);
    const checked = report(root, "--write");
    expect(checked.status).toBe(1);
    expect(checked.out).toContain("@intent-engine/client: createClient names Hidden, which no package root exports");
    expect(checked.out).toContain("@intent-engine/client: Client names Hidden, which no package root exports");
  });
});
