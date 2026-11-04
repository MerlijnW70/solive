import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIM_SECS, FAST_INTERVAL_SECS, FULL_INTERVAL_SECS, MAX_STAKE_LAMPORTS, runWorker, timingOf, WATCHED_INTERVAL_SECS } from "../../../scripts/demo-worker.mjs";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const RUNBOOK = read("docs/maintainers/operations.md");
const SECONDS = ["DEMO_WORKER_FAST_INTERVAL", "DEMO_WORKER_WATCHED_INTERVAL", "DEMO_WORKER_INTERVAL", "DEMO_WORKER_CLAIM_SECS"];

describe("the demo worker's settings", () => {
  it("default to the documented values", () => {
    expect(timingOf({})).toEqual({
      fastSecs: FAST_INTERVAL_SECS,
      fullSecs: FULL_INTERVAL_SECS,
      watchedSecs: WATCHED_INTERVAL_SECS,
      claimSecs: CLAIM_SECS,
      maxStake: BigInt(MAX_STAKE_LAMPORTS),
    });
  });

  it("read each value from its variable", () => {
    expect(
      timingOf({
        DEMO_WORKER_FAST_INTERVAL: "2.5",
        DEMO_WORKER_INTERVAL: "60",
        DEMO_WORKER_WATCHED_INTERVAL: "10",
        DEMO_WORKER_CLAIM_SECS: "300",
        DEMO_WORKER_MAX_STAKE_LAMPORTS: "1000",
      }),
    ).toEqual({ fastSecs: 2.5, fullSecs: 60, watchedSecs: 10, claimSecs: 300, maxStake: 1000n });
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

  for (const bad of ["abc", "-1", "1.5", "0x10", "NaN"]) {
    it(`refuse ${JSON.stringify(bad)} as the stake cap at startup`, async () => {
      const env = { DEMO_WORKER_KEYPAIR: "/nowhere/key.json", DEMO_WORKER_MAX_STAKE_LAMPORTS: bad };
      await expect(runWorker(env, ["--once", "--", "false"])).rejects.toThrow(`DEMO_WORKER_MAX_STAKE_LAMPORTS is a whole number of lamports, not "${bad}"`);
    });
  }
});

describe("the demo worker's runbook", () => {
  const variables = [...new Set([...read("scripts/demo-worker.mts").matchAll(/DEMO_WORKER_[A-Z_]+/g), ...read("scripts/demo-worker.sh").matchAll(/DEMO_WORKER_[A-Z_]+/g)].map((m) => m[0]))].sort();

  it("documents every variable the worker and its wrapper read", () => {
    expect(variables.length).toBeGreaterThanOrEqual(13);
    for (const name of variables) {
      expect(RUNBOOK, name).toMatch(new RegExp(`^\\| \`${name}\` \\| .+ \\| .+ \\|$`, "m"));
    }
  });

  it("states the default of each number as the worker holds it", () => {
    const row = (name: string) => new RegExp(`^\\| \`${name}\` \\| ([^|]+) \\|`, "m").exec(RUNBOOK)?.[1]?.trim();
    expect(row("DEMO_WORKER_FAST_INTERVAL")).toBe(String(FAST_INTERVAL_SECS));
    expect(row("DEMO_WORKER_WATCHED_INTERVAL")).toBe(String(WATCHED_INTERVAL_SECS));
    expect(row("DEMO_WORKER_INTERVAL")).toBe(String(FULL_INTERVAL_SECS));
    expect(row("DEMO_WORKER_CLAIM_SECS")).toBe(String(CLAIM_SECS));
    expect(row("DEMO_WORKER_MAX_STAKE_LAMPORTS")).toBe(String(MAX_STAKE_LAMPORTS));
  });
});
