import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPEC_READ_MS } from "@intent-engine/client/internal";
import { DETAIL_BYTES } from "../src/draw.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}/${path}`, "utf8");

const BYTES_PER_KIB = 1024;
const SECONDS_PER_DAY = 86_400;
const LAMPORTS_PER_SOL = 1_000_000_000;

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
const limits = read("services/specs/src/limits.ts");
const costStep = assigned(limits, /^export const COST_STEP_BYTES = ([\d_]+);$/m);
const stepUnits = assigned(limits, /^export const MIN_ESCROW_UNITS = ([\d_]+)n;$/m);
const paidDays = assigned(limits, /^export const PAID_GRACE_SECS = ([\d_]+);$/m) / SECONDS_PER_DAY;
const sweep = /^\s*"schedule": "\d+ \d+ \* \* \*"$/m.test(read("services/specs/vercel.json"));
const unpaidDays = assigned(limits, /^export const UNPAID_GRACE_SECS = ([\d_]+);$/m) / SECONDS_PER_DAY;
const sweepDays = sweep && unpaidDays <= 1 ? 1 : Number.NaN;
const sweepWords = sweepDays === 1 ? "a day" : `${sweepDays} days`;
const stepSol = stepUnits / LAMPORTS_PER_SOL;

const CLAIMS: readonly { doc: string; claim: string; source: string }[] = [
  { doc: "docs/sdk-client.md", claim: `one read stops asking sources after SPEC_READ_MS (${SPEC_READ_MS}, in milliseconds)`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/sdk-client.md", claim: `retries a 403, 429 or 503 within SPEC_READ_MS (${SPEC_READ_MS}, in milliseconds)`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/sdk-client.md", claim: `lock 0.01 SOL per COST_STEP_BYTES (${costStep}, in bytes) of spec`, source: "COST_STEP_BYTES in services/specs/src/limits.ts" },
  { doc: "docs/mcp.md", claim: `lock ${stepSol} SOL per COST_STEP_BYTES (${costStep}, in bytes) of spec`, source: "MIN_ESCROW_UNITS and COST_STEP_BYTES in services/specs/src/limits.ts" },
  { doc: "docs/mcp.md", claim: `up to ${sweepWords} after they end unfilled and ${paidDays} days after a fill`, source: "the daily cron in services/specs/vercel.json, UNPAID_GRACE_SECS and PAID_GRACE_SECS in services/specs/src/limits.ts" },
  { doc: "docs/mcp.md", claim: `the upload adds up to SPEC_READ_MS (${SPEC_READ_MS}, in milliseconds) to the send's answer`, source: "SPEC_READ_MS in packages/client/src/spec-sources.ts" },
  { doc: "docs/judge.md", claim: `DETAIL_BYTES (${DETAIL_BYTES}, in bytes)`, source: "DETAIL_BYTES in packages/cli/src/draw.ts" },
  { doc: "docs/maintainers/operations.md", claim: `with a time ${retryHours} hours ahead`, source: "retry_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `After ${parks} such tries, ${parks * retryHours} hours in all`, source: "max_parks and retry_secs in scripts/faucet.sh" },
];

describe("the numbers the docs state", () => {
  it.each(CLAIMS)("$doc states $claim, from $source", ({ doc, claim, source }) => {
    expect(read(doc)).toContain(claim);
    process.stdout.write(`measured ${(claim.match(/\d+(\.\d+)? (ms|KiB|hours|days|SOL|in bytes)/g) ?? [claim]).join(", ")} for ${doc} from ${source}\n`);
  });
});
