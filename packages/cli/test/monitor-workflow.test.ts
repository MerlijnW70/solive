import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { parse } from "../src/args.js";
import { VERSION } from "../src/version.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/monitor.yml"), "utf8");
const FAUCET_WORKFLOW = readFileSync(join(ROOT, ".github/workflows/faucet.yml"), "utf8");
const runsPerHour = (workflow: string) => (/^ {4}- cron: "([\d,]+) \* \* \* \*"$/m.exec(workflow)?.[1] ?? "").split(",").filter((m) => m !== "").length;
const BASELINE = JSON.parse(readFileSync(join(ROOT, "monitoring/devnet.json"), "utf8")) as {
  program: string;
  upgradeAuthority: string;
  programHash: string;
  committeeFloors: Record<string, string>;
  mintCaps: Record<string, Record<string, unknown>>;
};

const TEN_SOL = 10_000_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const FILLER_WALLET = "EuagWg1chJxXVJAXm2GiGiivtMRKGaFCFWY8G8PPM6My";
const FAUCET_WALLET = "CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS";
const script = (name: string) => readFileSync(join(ROOT, "scripts", name), "utf8");
const assigned = (text: string, name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(text)?.[1]);

describe("the hosted monitor", () => {
  it("checks devnet every quarter hour against the committed baseline, with the released command line", () => {
    expect(WORKFLOW).toContain('cron: "37 * * * *"');
    const runs = WORKFLOW.split("\n").filter((line) => line.includes("run: npx"));
    expect(runs).toHaveLength(2);
    expect(WORKFLOW).toContain(`CLI: "${VERSION}"`);
    expect(WORKFLOW).toContain('if npm view "@intent-engine/cli@$CLI" version > /dev/null 2>&1; then');
    expect(WORKFLOW).toContain('echo "RUN_CLI=$CLI" >> "$GITHUB_ENV"');
    for (const line of runs) {
      expect(line).toContain('"@intent-engine/cli@$RUN_CLI" monitor --expect monitoring/devnet.json');
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

  it("alerts on the filler's and the faucet's SOL and on swaps the filler leaves open, each value stated once", () => {
    const runs = WORKFLOW.split("\n").filter((line) => line.includes("run: npx"));
    const argv = (runs[0] ?? "").split(" monitor ")[1]?.split(" ") ?? [];
    const watch = (parse(["monitor", ...argv], {}) as { watch: { minBalance: ReadonlyMap<string, bigint>; maxSwapWait: number } }).watch;
    expect([...watch.minBalance.keys()]).toEqual([FILLER_WALLET, FAUCET_WALLET]);
    const faucet = script("faucet.sh");
    expect(watch.minBalance.get(FAUCET_WALLET)).toBeGreaterThan(BigInt(assigned(faucet, "amount") + assigned(faucet, "reserve")));
    expect(runsPerHour(WORKFLOW)).toBe(1);
    const faucetRuns = runsPerHour(FAUCET_WORKFLOW) / runsPerHour(WORKFLOW);
    expect(faucetRuns).toBeGreaterThan(1);
    expect(watch.minBalance.get(FAUCET_WALLET)).toBeGreaterThan(BigInt(assigned(faucet, "reserve") + assigned(faucet, "amount") * faucetRuns));
    expect(watch.minBalance.get(FILLER_WALLET)).toBeGreaterThanOrEqual(LAMPORTS_PER_SOL);
    const fillerInterval = Number(/^interval="\$\{FILLER_INTERVAL:-(\d+)\}"$/m.exec(script("filler.sh"))?.[1]);
    expect(fillerInterval).toBeGreaterThan(0);
    expect(watch.maxSwapWait).toBeGreaterThan(fillerInterval);
    for (const value of [FILLER_WALLET, FAUCET_WALLET, "--max-swap-wait"]) {
      expect(WORKFLOW.split(value)).toHaveLength(2);
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
