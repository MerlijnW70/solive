import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PUBLISHED = ["core", "client", "solver", "cli"];

describe("supply chain", () => {
  it("pins every dependency of a published package to an exact version", () => {
    const loose = PUBLISHED.flatMap((pkg) => {
      const manifest = JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8")) as {
        private?: boolean;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      expect(manifest.private, pkg).not.toBe(true);
      return Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
        .filter(([, range]) => !/^(workspace:\*|\d+\.\d+\.\d+)$/.test(range))
        .map(([name, range]) => `${pkg}: ${name} ${range}`);
    });
    expect(loose).toEqual([]);
    expect(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8")).toMatch(/^strictDepBuilds: true$/m);
  });

  it("the installed tree matches the committed production trees and every install script is reviewed", () => {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "supply-chain.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(out).toContain(`supply chain check passed: ${[...PUBLISHED].sort().join(", ")}`);
  }, 60_000);
});
