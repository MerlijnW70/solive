import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPEC_READ_MS } from "@intent-engine/client/internal";
import { DETAIL_BYTES } from "../src/draw.js";
import { HOST_CALL_MS } from "../src/host-judge.js";
import { NODE_CASE_MS } from "../src/node-judge.js";

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
const checkHours = assigned(faucet, /^check_secs=\$\(\((\d+) \* 3600\)\)$/m);
const guard = read("scripts/demo-guard.mts");
const guardSecs = (name: string): number => assigned(guard, new RegExp(`^export const ${name} = ([\\d_]+);$`, "m"));
const claimMargin = guardSecs("CLAIM_MARGIN_SECS");
const reviewRecheck = guardSecs("REVIEW_RECHECK_SECS");
const collectRetry = guardSecs("COLLECT_RETRY_SECS");
const collectRetryMax = guardSecs("MAX_COLLECT_RETRY_SECS");
const overdue = guardSecs("OVERDUE_SECS");
const busyHold = assigned(read("scripts/demo-chain.mts"), /^export const BUSY_HOLD_MS = ([\d_]+);$/m);
const install = read("scripts/demo-worker-install.sh");
const logSize = assigned(install, /^ {2}size (\d+)M$/m);
const logRotate = assigned(install, /^ {2}rotate (\d+)$/m);
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
  { doc: "docs/judge.md", claim: `\`HOST_CALL_MS\` (${HOST_CALL_MS}, in milliseconds)`, source: "HOST_CALL_MS in packages/cli/src/host-judge.ts" },
  { doc: "docs/judge.md", claim: `\`NODE_CASE_MS\` (${NODE_CASE_MS}, in milliseconds)`, source: "NODE_CASE_MS in packages/cli/src/node-judge.ts" },
  { doc: "docs/maintainers/operations.md", claim: `with a time \`retry_secs\` (${retryHours}, in hours) ahead`, source: "retry_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `After \`max_parks\` (${parks}) such tries (${parks * retryHours}, in hours, in all)`, source: "max_parks and retry_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `at least \`check_secs\` (${checkHours}, in hours) later`, source: "check_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `a lag shorter than \`check_secs\` (${checkHours}, in hours)`, source: "check_secs in scripts/faucet.sh" },
  { doc: "docs/maintainers/operations.md", claim: `at the latest \`CLAIM_MARGIN_SECS\` (${claimMargin}, in seconds) before`, source: "CLAIM_MARGIN_SECS in scripts/demo-guard.mts" },
  { doc: "docs/maintainers/operations.md", claim: `at most every \`REVIEW_RECHECK_SECS\` (${reviewRecheck}, in seconds) while`, source: "REVIEW_RECHECK_SECS in scripts/demo-guard.mts" },
  { doc: "docs/maintainers/operations.md", claim: `retried after \`COLLECT_RETRY_SECS\` (${collectRetry}, in seconds), then twice as long each time, up to \`MAX_COLLECT_RETRY_SECS\` (${collectRetryMax}, in seconds).`, source: "COLLECT_RETRY_SECS and MAX_COLLECT_RETRY_SECS in scripts/demo-guard.mts" },
  { doc: "docs/maintainers/operations.md", claim: `or \`BUSY_HOLD_MS\` (${busyHold}, in milliseconds) when the header`, source: "BUSY_HOLD_MS in scripts/demo-chain.mts" },
  { doc: "docs/maintainers/operations.md", claim: `owed for over \`OVERDUE_SECS\` (${overdue}, in seconds) after a review ended, plus stakes of claims held \`OVERDUE_SECS\` (${overdue}, in seconds) past their end`, source: "OVERDUE_SECS in scripts/demo-guard.mts" },
  { doc: "docs/maintainers/operations.md", claim: `bounds the log at \`rotate ${logRotate}\` (${logRotate} rotations) of \`size ${logSize}M\` (${logSize}, in megabytes)`, source: "size and rotate in scripts/demo-worker-install.sh" },
  { doc: "docs/maintainers/operations.md", claim: `copy at most \`size ${logSize}M\` (${logSize}, in megabytes):`, source: "size in scripts/demo-worker-install.sh" },
];

describe("the numbers the docs state", () => {
  it.each(CLAIMS)("$doc states $claim, from $source", ({ doc, claim, source }) => {
    expect(read(doc)).toContain(claim);
    process.stdout.write(`measured ${(claim.match(/\d+(?:\.\d+)?(?:, in \w+| (?:ms|KiB|hours|days|SOL|in bytes))/g) ?? [claim]).join(", ")} for ${doc} from ${source}\n`);
  });
});

const NUMBER_IN_WORD = /\b\d[\d_.]*,\s+in\s+(\w+)/gi;
const NOT_A_UNIT = new Set(["the", "two", "batches"]);

const docFiles = (dir: string): string[] =>
  readdirSync(`${ROOT}/${dir}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return ["reference", "node_modules", ".vitepress"].includes(entry.name) ? [] : docFiles(path);
    }
    return entry.name.endsWith(".md") ? [path] : [];
  });

describe("the unit form in the docs", () => {
  it("has a pin for every number written as N, in a word, once per occurrence", () => {
    const docs = docFiles("docs");
    expect(docs.length).toBeGreaterThan(0);
    const unpinned = docs.flatMap((doc) => {
      const left = CLAIMS.filter((claim) => claim.doc === doc).reduce((text, { claim }) => text.replace(claim, ""), read(doc));
      return [...left.matchAll(NUMBER_IN_WORD)].filter((hit) => !NOT_A_UNIT.has((hit[1] ?? "").toLowerCase())).map((hit) => `${doc}: ${hit[0]}`);
    });
    expect(unpinned).toEqual([]);
  });
});
