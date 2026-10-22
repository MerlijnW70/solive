import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS, NATIVE_MINT } from "@intent-engine/core";
import { parse } from "../src/args.js";
import { VERSION } from "../src/version.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/monitor.yml"), "utf8");
const BASELINE = JSON.parse(readFileSync(join(ROOT, "monitoring/devnet.json"), "utf8")) as {
  program: string;
  upgradeAuthority: string;
  programHash: string;
  committeeFloors: Record<string, string>;
  mintCaps: Record<string, Record<string, unknown>>;
};

const TEN_SOL = 10_000_000_000n;

describe("the hosted monitor", () => {
  it("checks devnet every quarter hour against the committed baseline, with the released command line", () => {
    expect(WORKFLOW).toContain('cron: "37 * * * *"');
    const runs = WORKFLOW.split("\n").filter((line) => line.includes("run: npx"));
    expect(runs).toHaveLength(2);
    for (const line of runs) {
      expect(line).toContain(`@intent-engine/cli@${VERSION} monitor --expect monitoring/devnet.json`);
      expect(line).toContain(`--max-fill ${NATIVE_MINT}=${TEN_SOL}`);
      expect(line).toContain("--once --since 3900");
      const argv = (line.split(" monitor ")[1] ?? "").split(" ").map((arg) => (arg === '"$SECOND_RPC"' ? "devnet" : arg));
      expect(parse(["monitor", ...argv], {})).toMatchObject({
        name: "monitor",
        baseline: "monitoring/devnet.json",
        watch: { interval: 30, since: 3900, maxFill: new Map([[NATIVE_MINT, TEN_SOL]]), maxFills: 50, once: true },
      });
    }
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read$/m);
    for (const line of WORKFLOW.split("\n").filter((l) => l.includes("uses:"))) {
      expect(line).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("asks a second node only when its address is set, and keeps that address out of the repository", () => {
    expect(WORKFLOW).toContain("SECOND_RPC: ${{ secrets.SECOND_DEVNET_RPC }}");
    expect(WORKFLOW).toContain("if: env.SECOND_RPC != ''");
    expect(WORKFLOW).not.toMatch(/alchemy\.com|api-key|alch_/i);
  });

  it("baselines the deployed program with a hash the monitor can compare", () => {
    expect(BASELINE.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(BASELINE.programHash).toMatch(/^[0-9a-f]{64}$/);
    expect(BASELINE.upgradeAuthority).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(typeof BASELINE.committeeFloors).toBe("object");
    expect(typeof BASELINE.mintCaps).toBe("object");
    for (const limits of Object.values(BASELINE.mintCaps)) {
      expect(Object.keys(limits)).toEqual(["maxPerOrder", "windowCap", "windowSecs", "totalLimit"]);
    }
  });
});
