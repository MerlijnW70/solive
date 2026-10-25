import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "packages/client/src");
const ACCOUNTS = join(ROOT, "packages/core/generated/client/accounts");
const ALLOWED: ReadonlySet<string> = new Set<string>();

const NAMES = readdirSync(ACCOUNTS)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => `${file.charAt(0).toUpperCase()}${file.slice(1, -3)}`);

const RAW = new RegExp(`\\b(?:get(?:${NAMES.join("|")})(?:Decoder|Codec)|(?:decode|fetch|fetchMaybe|fetchAll|fetchAllMaybe)(?:${NAMES.join("|")}))\\b`, "g");

const posix = (file: string): string => file.replaceAll("\\", "/");

function rawDecodes(file: string, text: string): string[] {
  return text.split("\n").flatMap((line, i) => [...line.matchAll(RAW)].map((found) => `${file}:${i + 1}: ${found[0]}`));
}

describe("engine account decodes in client src", () => {
  it("spot a raw generated account decoder", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(13);
    expect(rawDecodes("a.ts", "const intent = getIntentDecoder().decode(data);")).toEqual(["a.ts:1: getIntentDecoder"]);
    expect(rawDecodes("a.ts", "const board = getClaimBoardCodec().decode(data);\nfetchMaybeConfig(rpc, at);")).toEqual(["a.ts:1: getClaimBoardCodec", "a.ts:2: fetchMaybeConfig"]);
    expect(rawDecodes("a.ts", "decodeIntentAccount(data); getIntentSize(); getIntentDiscriminatorBytes(); getFillAttestedSplitInstructionDataDecoder();")).toEqual([]);
  });

  it("go through the core decode functions for every engine account", () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[]).map(posix).filter((file) => file.endsWith(".ts") && !ALLOWED.has(file));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => rawDecodes(file, readFileSync(join(SRC, file), "utf8")))).toEqual([]);
  });
});
