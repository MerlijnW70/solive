import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPEC_READ_MS } from "@intent-engine/client/internal";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}/${path}`, "utf8");

const BYTES_PER_KIB = 1024;

const assigned = (text: string, pattern: RegExp): number => {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) {
    throw new Error(`no value for ${pattern.source}`);
  }
  return Number(found.replaceAll("_", ""));
};

const faucet = read("scripts/faucet.sh");
const retryHours = assigned(faucet, /^retry_secs=\$\(\((\d+) \* 3600\)\)$/m);
const parks = assigned(faucet, /^max_parks=(\d+)$/m);
const costStep = assigned(read("services/specs/src/limits.ts"), /^export const COST_STEP_BYTES = ([\d_]+);$/m);

const CLAIMS: readonly { doc: string; claim: string; source: string }[] = [
  { doc: "docs/sdk-client.md", claim: `one read stops asking sources after ${SPEC_READ_MS} ms`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/sdk-client.md", claim: `retries a 403, 429 or 503 within ${SPEC_READ_MS} ms`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/sdk-client.md", claim: `lock 0.01 SOL per ${costStep / BYTES_PER_KIB} KiB of spec`, source: "COST_STEP_BYTES in services/specs/src/limits.ts" },
  { doc: "docs/mcp.md", claim: `lock 0.01 SOL per ${costStep / BYTES_PER_KIB} KiB of spec`, source: "COST_STEP_BYTES in services/specs/src/limits.ts" },
  { doc: "docs/mcp.md", claim: `the upload adds up to ${SPEC_READ_MS} ms to the send's answer`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/maintainers/operations.md", claim: `with a time ${retryHours} hours ahead`, source: "retry_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `After ${parks} such tries, ${parks * retryHours} hours in all`, source: "max_parks and retry_secs in scripts/faucet.sh" },
];

describe("the numbers the docs state", () => {
  it.each(CLAIMS)("$doc states $claim, from $source", ({ doc, claim, source }) => {
    expect(read(doc)).toContain(claim);
    process.stdout.write(`measured ${claim.match(/\d+ (ms|KiB|hours)/g)?.join(", ") ?? ""} for ${doc} from ${source}\n`);
  });
});
