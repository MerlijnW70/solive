import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/deployed.sh");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
const BUILT = "a".repeat(64);

const VERIFY = `#!/usr/bin/env bash
echo "solana-verify $*" >> "$STUB_LOG"
echo "$STUB_HASH"
`;

function check(cluster: string, deployed: string, built = BUILT): { code: number; log: string; output: string } {
  const work = mkdtempSync(join(tmpdir(), "deployed-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "solana-verify"), VERIFY);
  chmodSync(join(bin, "solana-verify"), 0o755);
  const hash = join(work, "intent_engine.hash");
  writeFileSync(hash, `${built}\n`);
  const log = join(work, "log");
  writeFileSync(log, "");
  try {
    const output = execFileSync("bash", [SCRIPT, cluster, hash], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, STUB_LOG: log, STUB_HASH: deployed },
    });
    return { code: 0, log: readFileSync(log, "utf8"), output };
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return { code: failed.status ?? 1, log: readFileSync(log, "utf8"), output: failed.stderr ?? "" };
  }
}

describe("the deployed program check", () => {
  it("passes when the devnet program hash equals the verifiable build of the commit", () => {
    const run = check("devnet", BUILT);
    expect(run.code).toBe(0);
    expect(run.log.trim()).toBe(`solana-verify get-program-hash -u ${"https://"}api.devnet.solana.com ${PROGRAM}`);
    expect(run.output).toContain(`matches the verifiable build ${BUILT}`);
  });

  it("fails and names both hashes when devnet runs a different binary", () => {
    const run = check("devnet", "b".repeat(64));
    expect(run.code).toBe(1);
    expect(run.output).toContain("b".repeat(64));
    expect(run.output).toContain(BUILT);
  });

  it("refuses another cluster or a hash file that holds no hash, without reading the chain", () => {
    expect(check("mainnet-beta", BUILT)).toMatchObject({ code: 2, log: "" });
    expect(check("devnet", BUILT, "not a hash")).toMatchObject({ code: 2, log: "" });
  });

  it("runs nightly and on demand, after the verifiable build it compares against", () => {
    const job = CI.slice(CI.indexOf("\n  deployed:"), CI.indexOf("\n  randomized:"));
    expect(job).toContain("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(job).toContain("needs: verifiable");
    expect(job).toContain("name: intent-engine-verifiable");
    expect(job).toContain("bash scripts/deployed.sh devnet verifiable/intent_engine.hash");
  });
});
