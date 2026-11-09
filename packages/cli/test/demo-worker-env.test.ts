import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { worker } from "./demo-worker-module.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const { CLAIM_SECS, COLLECT_INTERVAL_SECS, FAST_INTERVAL_SECS, FULL_INTERVAL_SECS, MAX_AT_RISK_LAMPORTS, MAX_OWNER_LAMPORTS, MAX_STAKE_LAMPORTS, runWorker, timingOf, USAGE, WATCHED_INTERVAL_SECS } = worker;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const RUNBOOK = read("docs/maintainers/operations.md");
const SECONDS = ["DEMO_WORKER_FAST_INTERVAL", "DEMO_WORKER_WATCHED_INTERVAL", "DEMO_WORKER_INTERVAL", "DEMO_WORKER_COLLECT_INTERVAL", "DEMO_WORKER_CLAIM_SECS"];
const LAMPORTS = ["DEMO_WORKER_MAX_STAKE_LAMPORTS", "DEMO_WORKER_MAX_AT_RISK_LAMPORTS", "DEMO_WORKER_MAX_OWNER_LAMPORTS"];
const SOURCES = [...readdirSync(join(ROOT, "scripts")).filter((name) => /^demo-.*\.(mts|sh)$/.test(name)).map((name) => `scripts/${name}`)];

describe("the demo worker's settings", () => {
  it("default to the documented values", () => {
    expect(timingOf({})).toEqual({
      fastSecs: FAST_INTERVAL_SECS,
      fullSecs: FULL_INTERVAL_SECS,
      watchedSecs: WATCHED_INTERVAL_SECS,
      collectSecs: COLLECT_INTERVAL_SECS,
      claimSecs: CLAIM_SECS,
      maxStake: BigInt(MAX_STAKE_LAMPORTS),
      maxAtRisk: BigInt(MAX_AT_RISK_LAMPORTS),
      maxPerOwner: BigInt(MAX_OWNER_LAMPORTS),
    });
  });

  it("read each value from its variable", () => {
    expect(
      timingOf({
        DEMO_WORKER_FAST_INTERVAL: "2.5",
        DEMO_WORKER_INTERVAL: "60",
        DEMO_WORKER_WATCHED_INTERVAL: "10",
        DEMO_WORKER_COLLECT_INTERVAL: "45",
        DEMO_WORKER_CLAIM_SECS: "300",
        DEMO_WORKER_MAX_STAKE_LAMPORTS: "1000",
        DEMO_WORKER_MAX_AT_RISK_LAMPORTS: "3000",
        DEMO_WORKER_MAX_OWNER_LAMPORTS: "2000",
      }),
    ).toEqual({ fastSecs: 2.5, fullSecs: 60, watchedSecs: 10, collectSecs: 45, claimSecs: 300, maxStake: 1000n, maxAtRisk: 3000n, maxPerOwner: 2000n });
  });

  for (const name of SECONDS) {
    for (const bad of ["abc", "NaN", "0", "-5", "Infinity", "1e3", "5s", " "]) {
      it(`refuse ${JSON.stringify(bad)} in ${name} at startup, before the worker reaches the node`, async () => {
        const env = { DEMO_WORKER_KEYPAIR: "/nowhere/key.json", [name]: bad };
        expect(() => timingOf(env)).toThrow(name);
        await expect(runWorker(env, ["--once", "--", "false"])).rejects.toThrow(`${name} is a number of seconds above 0, not "${bad}"`);
      });
    }
  }

  for (const name of LAMPORTS) {
    for (const bad of ["abc", "-1", "1.5", "0x10", "NaN"]) {
      it(`refuse ${JSON.stringify(bad)} in ${name} at startup`, async () => {
        const env = { DEMO_WORKER_KEYPAIR: "/nowhere/key.json", [name]: bad };
        await expect(runWorker(env, ["--once", "--", "false"])).rejects.toThrow(`${name} is a whole number of lamports, not "${bad}"`);
      });
    }
  }
});

describe("the demo worker's runbook", () => {
  const variables = [...new Set(SOURCES.flatMap((path) => [...read(path).matchAll(/DEMO_WORKER_[A-Z_]+/g)].map((m) => m[0])))].sort();

  it("documents every variable the worker, its wrapper and its installer read", () => {
    expect(variables.length).toBeGreaterThanOrEqual(18);
    for (const name of variables) {
      expect(RUNBOOK, name).toMatch(new RegExp(`^\\| \`${name}\` \\| .+ \\| .+ \\|$`, "m"));
    }
  });

  it("matches the usage text, which names every variable the worker and its wrapper read with the default of each number", () => {
    const own = [...new Set(["scripts/demo-worker.mts", "scripts/demo-worker.sh"].flatMap((path) => [...read(path).matchAll(/DEMO_WORKER_[A-Z_]+/g)].map((m) => m[0])))];
    for (const name of own) {
      expect(USAGE, name).toMatch(new RegExp(`^${name} `, "m"));
    }
    for (const [name, value] of [["DEMO_WORKER_FAST_INTERVAL", FAST_INTERVAL_SECS], ["DEMO_WORKER_MAX_AT_RISK_LAMPORTS", MAX_AT_RISK_LAMPORTS], ["DEMO_WORKER_MAX_OWNER_LAMPORTS", MAX_OWNER_LAMPORTS]] as const) {
      expect(USAGE).toMatch(new RegExp(`^${name} .*; default ${value}$`, "m"));
    }
  });

  it("states the default of each number as the worker holds it", () => {
    const row = (name: string) => new RegExp(`^\\| \`${name}\` \\| ([^|]+) \\|`, "m").exec(RUNBOOK)?.[1]?.trim();
    expect(row("DEMO_WORKER_FAST_INTERVAL")).toBe(String(FAST_INTERVAL_SECS));
    expect(row("DEMO_WORKER_WATCHED_INTERVAL")).toBe(String(WATCHED_INTERVAL_SECS));
    expect(row("DEMO_WORKER_INTERVAL")).toBe(String(FULL_INTERVAL_SECS));
    expect(row("DEMO_WORKER_COLLECT_INTERVAL")).toBe(String(COLLECT_INTERVAL_SECS));
    expect(row("DEMO_WORKER_CLAIM_SECS")).toBe(String(CLAIM_SECS));
    expect(row("DEMO_WORKER_MAX_STAKE_LAMPORTS")).toBe(String(MAX_STAKE_LAMPORTS));
    expect(row("DEMO_WORKER_MAX_AT_RISK_LAMPORTS")).toBe(String(MAX_AT_RISK_LAMPORTS));
    expect(row("DEMO_WORKER_MAX_OWNER_LAMPORTS")).toBe(String(MAX_OWNER_LAMPORTS));
  });
});
