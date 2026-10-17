import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { VERSION } from "../src/version.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/monitor.yml"), "utf8");
const BASELINE = JSON.parse(readFileSync(join(ROOT, "monitoring/devnet.json"), "utf8")) as {
  program: string;
  upgradeAuthority: string;
  programHash: string;
};

describe("the hosted monitor", () => {
  it("checks devnet every quarter hour against the committed baseline, with the released command line", () => {
    expect(WORKFLOW).toContain('cron: "*/15 * * * *"');
    const runs = WORKFLOW.split("\n").filter((line) => line.includes("run: npx"));
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line).toContain(`@intent-engine/cli@${VERSION} monitor --expect monitoring/devnet.json`);
      expect(line).toContain("--once");
    }
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read$/m);
    for (const line of WORKFLOW.split("\n").filter((l) => l.includes("uses:"))) {
      expect(line).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("asks a second node only when its address is set, and keeps that address out of the repository", () => {
    expect(WORKFLOW).toContain("SECOND_RPC: ${{ secrets.ALCHEMY_DEVNET_RPC }}");
    expect(WORKFLOW).toContain("if: env.SECOND_RPC != ''");
    expect(WORKFLOW).not.toMatch(/alchemy\.com|api-key|alch_/i);
  });

  it("baselines the deployed program with a hash the monitor can compare", () => {
    expect(BASELINE.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(BASELINE.programHash).toMatch(/^[0-9a-f]{64}$/);
    expect(BASELINE.upgradeAuthority).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
