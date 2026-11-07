import * as kit from "@solana/kit";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "@intent-engine/core";
import * as client from "../src/index.js";
import * as node from "../src/node.js";
import * as svm from "../src/svm.js";
import * as testing from "../src/testing.js";

const repo = process.env["INTENT_ENGINE_ROOT"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const reports = [read("packages", "client", "api-report.txt"), read("packages", "core", "api-report.txt")];
const entries = new Set([...Object.keys(client), ...Object.keys(core), ...Object.keys(node), ...Object.keys(svm), ...Object.keys(testing), ...Object.keys(kit)]);
const ENVIRONMENT = new Set(["INTENT_ENGINE_SPEC_MIRROR", "INTENT_ENGINE_KEYPAIR"]);

const clientMethods = new Set(
  (reports[0] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("type Client:"))
    .flatMap((line) => [...line.matchAll(/(\w+)\(/g)].map((match) => match[1] ?? "")),
);

const exported = (name: string): boolean => entries.has(name) || clientMethods.has(name);

function cited(markdown: string): string[] {
  const names = new Set<string>();
  for (const [, token] of markdown.matchAll(/`([^`\n]+)`/g)) {
    const constant = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.exec(token ?? "");
    const call = /^([A-Za-z_]\w*)\(/.exec(token ?? "");
    const name = constant?.[0] ?? call?.[1];
    if (name !== undefined && !ENVIRONMENT.has(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

describe("names the docs cite", () => {
  for (const page of [["docs", "sdk-client.md"], ["docs", "mcp.md"]]) {
    it(`are all public exports in ${page.join("/")}`, () => {
      const names = cited(read(...page));
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => !exported(name))).toEqual([]);
    });
  }

  it("finds a name that is not exported", () => {
    expect(cited("uses `DEFAULT_NOTHING_HERE` and `gone()` and `createClient({ url })` and `NODE_ENV`")).toEqual(["DEFAULT_NOTHING_HERE", "NODE_ENV", "createClient", "gone"]);
    expect(["DEFAULT_NOTHING_HERE", "gone"].filter((name) => !exported(name))).toEqual(["DEFAULT_NOTHING_HERE", "gone"]);
    expect(exported("defaultSpecSources")).toBe(true);
    expect(exported("DEFAULT_SPEC_SOURCES")).toBe(true);
  });

  it("promises no builders in the core readme that its entry lacks", () => {
    const builders = Object.keys(core).some((name) => /^build[A-Z]/.test(name));
    const sentences = read("packages", "core", "README.md").split(/(?<=\.)\s/).filter((sentence) => /\bbuilders\b/.test(sentence));
    expect(sentences.filter((sentence) => !builders && !/\bnot\b/.test(sentence))).toEqual([]);
  });
});
