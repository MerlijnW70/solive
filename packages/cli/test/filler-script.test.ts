import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { parse } from "../src/args.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));

function solveCommand() {
  const dir = mkdtempSync(join(tmpdir(), "filler-solve-"));
  const log = join(dir, "calls.log");
  const stub = join(dir, "cli");
  writeFileSync(log, "");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${log}"\n`);
  chmodSync(stub, 0o755);
  spawnSync("bash", [join(ROOT, "scripts", "filler.sh")], { cwd: dir, encoding: "utf8", timeout: 2500, env: { ...process.env, FILLER_CLI: stub, FILLER_KEYPAIR: "filler.json" } });
  const line = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("solve "));
  expect(line).toBeDefined();
  return parse((line ?? "").split(" "), {});
}

describe("the devnet filler", () => {
  it("prices every profit floor it sets in SOL at the rate it issues the token", () => {
    const command = solveCommand();
    expect(command.name).toBe("solve");
    if (command.name !== "solve") {
      return;
    }
    expect(command.issue).toHaveLength(1);
    const [issue] = command.issue;
    expect(issue?.inputMint).toBe(NATIVE_MINT);
    expect(command.minProfit.size).toBeGreaterThan(0);
    for (const mint of command.minProfit.keys()) {
      expect(mint).toBe(issue?.outputMint);
      expect(command.solValue?.get(mint)).toEqual({ raw: issue?.out, lamports: issue?.in });
    }
  });
});
