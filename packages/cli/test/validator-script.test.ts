import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/validator-test.sh");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";

const VALIDATOR = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createServer } = require("node:http");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_PIDS, process.pid + "\\n");
appendFileSync(process.env.STUB_LOG, "validator " + args.join(" ") + "\\n");
if (process.env.STUB_SILENT === "1") {
  process.exit(1);
}
const port = Number(args[args.indexOf("--rpc-port") + 1]);
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
}).listen(port, "127.0.0.1");
`;

const KEYGEN = `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    echo "[]" > "$2"
  fi
  shift
done
`;

const PNPM = `#!/usr/bin/env bash
echo "pnpm $* $VALIDATOR_URL $VALIDATOR_AUTHORITY" >> "$STUB_LOG"
if [[ "$*" == *vitest* ]]; then
  curl -sf -d '{}' "$VALIDATOR_URL" >> "$STUB_LOG" || exit 9
  exit "$STUB_EXIT"
fi
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function run(env: Record<string, string>) {
  const work = mkdtempSync(join(tmpdir(), "validator-script-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const [name, body] of [
    ["solana-test-validator", VALIDATOR],
    ["solana-keygen", KEYGEN],
    ["pnpm", PNPM],
  ] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const engine = join(work, "intent_engine.so");
  writeFileSync(engine, "");
  const scratch = join(work, "tmp");
  mkdirSync(scratch);
  const pids = join(work, "pids");
  const log = join(work, "log");
  writeFileSync(pids, "");
  writeFileSync(log, "");
  const result = spawnSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: work,
      TMPDIR: scratch,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      INTENT_ENGINE_SO: engine,
      STUB_PIDS: pids,
      STUB_LOG: log,
      STUB_EXIT: "0",
      ...env,
    },
  });
  const started = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  return { code: result.status, stderr: result.stderr, log: readFileSync(log, "utf8"), started, left: readdirSync(scratch) };
}

describe.skipIf(process.platform === "win32")("the real validator script", () => {
  it("starts the program at its address on free ports, runs the validator test against it and stops the validator", { timeout: 150_000 }, () => {
    const done = run({});
    expect(done.code).toBe(0);
    expect(done.started).toHaveLength(1);
    expect(done.started.filter(alive)).toEqual([]);
    const [line] = done.log.split("\n").filter((entry) => entry.startsWith("validator "));
    expect(line).toContain(`--upgradeable-program ${PROGRAM}`);
    const port = Number(/--rpc-port (\d+)/.exec(line ?? "")?.[1]);
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(line).toContain(`--faucet-port ${port + 2}`);
    expect(done.log).toContain("exec vitest run --fsModuleCache test/validator.test.ts " + "http://" + "127.0.0.1:" + port);
    expect(done.log).toContain('"result":"ok"');
    expect(done.left).toEqual([]);
  });

  it("stops the validator and fails when the validator test fails", { timeout: 150_000 }, () => {
    const failed = run({ STUB_EXIT: "3" });
    expect(failed.code).toBe(3);
    expect(failed.started).toHaveLength(1);
    expect(failed.started.filter(alive)).toEqual([]);
    expect(failed.left).toEqual([]);
  });

  it("gives up after three validators that never answer and leaves none behind", { timeout: 150_000 }, () => {
    const silent = run({ STUB_SILENT: "1" });
    expect(silent.code).toBe(1);
    expect(silent.stderr).toContain("solana-test-validator did not answer");
    expect(silent.started).toHaveLength(3);
    expect(silent.started.filter(alive)).toEqual([]);
    expect(silent.log).not.toContain("exec vitest");
    expect(silent.left).toEqual([]);
  });

  it("runs in the CI job that installs agave", () => {
    const check = CI.slice(CI.indexOf("  check:"), CI.indexOf("  node-floor:"));
    expect(check).toContain("solana-release/bin");
    expect(check).toContain("run: bash scripts/validator-test.sh");
    expect(check.indexOf("run: bash scripts/ci.sh")).toBeLessThan(check.indexOf("run: bash scripts/validator-test.sh"));
  });
});
