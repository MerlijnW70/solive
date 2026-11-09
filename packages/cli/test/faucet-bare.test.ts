import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAUCET_URL_ENV } from "../src/faucet.js";
import { FAUCET_HOST } from "./faucet-guard.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "test"]);

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.has(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mts|mjs|js)$/.test(name) ? [path] : [];
  });

describe("a bare test run cannot reach the real instant faucet", { timeout: 300_000 }, () => {
  it("loads the faucet guard when vitest runs without --config", () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== FAUCET_URL_ENV && !key.startsWith("VITEST")) env[key] = value;
    }
    env["NO_COLOR"] = "1";
    delete env["FORCE_COLOR"];
    const run = spawnSync(join(PACKAGE, "node_modules", ".bin", "vitest"), ["run", "test/faucet-guard.test.ts", "-t", "turns the faucet off"], { cwd: PACKAGE, env, encoding: "utf8" });
    expect((run.stdout + run.stderr).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")).toMatch(/Tests\s+1 passed \| 6 skipped/);
    expect(run.status).toBe(0);
  });

  it("names the real faucet host in the shipped code of the command line package only", () => {
    const owners = ["packages", "services"].flatMap((area) =>
      readdirSync(join(ROOT, area))
        .filter((name) => sources(join(ROOT, area, name)).some((path) => readFileSync(path, "utf8").includes(FAUCET_HOST)))
        .map((name) => `${area}/${name}`),
    );
    expect(owners).toEqual(["packages/cli"]);
  });
});
