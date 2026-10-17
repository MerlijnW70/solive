import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/release.sh");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
const ORDER = ["core", "client", "solver", "cli"];

const PNPM = `#!/usr/bin/env bash
echo "pnpm $*" >> "$STUB_LOG"
if [ "$1" = "pack" ]; then
  version="$(node -p "require('./package.json').version")"
  touch "$3/intent-engine-$(basename "$PWD")-$version.tgz"
fi
`;

const NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
if [ "$1" = "view" ]; then
  case " $STUB_PUBLISHED " in *" $2 "*) echo "\${2##*@}"; exit 0 ;; esac
  exit 1
fi
`;

function release(tag: string, published: string[] = []): { code: number; log: string[]; output: string } {
  const work = mkdtempSync(join(tmpdir(), "release-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const [name, body] of [["pnpm", PNPM], ["npm", NPM]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const logFile = join(work, "log");
  writeFileSync(logFile, "");
  let code = 0;
  let output = "";
  try {
    output = execFileSync("bash", [SCRIPT, tag, join(work, "packs")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, STUB_LOG: logFile, STUB_PUBLISHED: published.join(" ") },
    });
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    code = failed.status ?? 1;
    output = failed.stderr ?? "";
  }
  return { code, log: readFileSync(logFile, "utf8").trim().split("\n").filter((line) => line !== ""), output };
}

const publishes = (log: string[]) => log.filter((line) => line.startsWith("npm publish"));

describe("the release workflow", () => {
  it("publishes the four packages in dependency order, each with provenance and public access", () => {
    const run = release(`v${VERSION}`);
    expect(run.code).toBe(0);
    const sent = publishes(run.log);
    expect(sent.map((line) => /intent-engine-([a-z]+)-/.exec(line)?.[1])).toEqual(ORDER);
    for (const line of sent) {
      expect(line).toContain(`-${VERSION}.tgz --access public --provenance`);
    }
    expect(run.log.filter((line) => line.startsWith("pnpm --filter")).length).toBe(4);
  });

  it("skips a version that is already on npm, so a rerun finishes the rest", () => {
    const run = release(`v${VERSION}`, [`@intent-engine/core@${VERSION}`, `@intent-engine/client@${VERSION}`]);
    expect(run.code).toBe(0);
    expect(publishes(run.log).map((line) => /intent-engine-([a-z]+)-/.exec(line)?.[1])).toEqual(["solver", "cli"]);
  });

  it("refuses a tag that does not match every package version, before building or publishing anything", () => {
    for (const tag of ["v9.9.9", VERSION, `v${VERSION}-rc.1`]) {
      const run = release(tag);
      expect(run.code).toBe(1);
      expect(run.log).toEqual([]);
    }
  });

  it("runs only for version tags, after ci passed on the commit, in the npm environment, with an identity token only for publishing", () => {
    expect(WORKFLOW).toContain('tags: ["v*.*.*"]');
    expect(WORKFLOW).not.toMatch(/^\s+branches:/m);
    expect(WORKFLOW).toContain("environment: npm");
    expect(WORKFLOW).toContain("id-token: write");
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(WORKFLOW).toContain("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&event=push&status=success");
    expect(WORKFLOW).toContain('bash scripts/release.sh "$GITHUB_REF_NAME"');
    expect(WORKFLOW).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
    for (const line of WORKFLOW.split("\n").filter((l) => l.includes("uses:"))) {
      expect(line).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
