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

const GH_SCRIPT = join(ROOT, "scripts/github-release.sh");

const GH = `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
if [ "$1 $2" = "release view" ]; then
  case " $STUB_RELEASES " in *" $3 "*) exit 0 ;; esac
  exit 1
fi
if [ "$1 $2" = "release create" ] && [ -n "$STUB_FAIL" ]; then
  exit 1
fi
`;

function githubRelease(tag: string, releases: string[] = [], fail = false): { code: number; log: string[] } {
  const work = mkdtempSync(join(tmpdir(), "github-release-"));
  const bin = join(work, "bin");
  const repo = join(work, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(bin, "gh"), GH);
  chmodSync(join(bin, "gh"), 0o755);
  const logFile = join(work, "log");
  writeFileSync(logFile, "");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  for (const [message, mark] of [["first change", "v0.1.0"], ["second change", ""], ["third change", "v0.1.1"]] as const) {
    git("commit", "-q", "--allow-empty", "-m", message);
    if (mark !== "") git("tag", mark);
  }
  let code = 0;
  try {
    execFileSync("bash", [GH_SCRIPT, tag], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, STUB_LOG: logFile, STUB_RELEASES: releases.join(" "), STUB_FAIL: fail ? "1" : "" },
    });
  } catch (error) {
    code = (error as { status?: number }).status ?? 1;
  }
  return { code, log: readFileSync(logFile, "utf8").trim().split("\n").filter((line) => line !== "") };
}

const JOBS = WORKFLOW.split("\njobs:\n")[1] ?? "";
const [PUBLISH_JOB = "", RELEASE_JOB = ""] = JOBS.split("\n  github-release:\n");

describe("the GitHub release", () => {
  it("runs as its own job after the publish and only when it succeeded", () => {
    expect(RELEASE_JOB).not.toBe("");
    expect(RELEASE_JOB).toContain("needs: publish");
    expect(RELEASE_JOB).not.toMatch(/\bif:/);
    expect(RELEASE_JOB).toContain('bash scripts/github-release.sh "$GITHUB_REF_NAME"');
    expect(PUBLISH_JOB).not.toContain("github-release");
    expect(PUBLISH_JOB).not.toContain("needs:");
  });

  it("holds contents write on that job alone, nothing wider", () => {
    expect(RELEASE_JOB).toMatch(/permissions:\n {6}contents: write\n/);
    expect(RELEASE_JOB).not.toMatch(/id-token|actions: |environment:/);
    expect(PUBLISH_JOB).not.toContain("contents: write");
    expect(WORKFLOW.match(/contents: write/g)?.length).toBe(1);
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("leaves the npm publish job as it was", () => {
    expect(PUBLISH_JOB).toContain("environment: npm");
    expect(PUBLISH_JOB).toContain("id-token: write");
    expect(PUBLISH_JOB).toContain('run: bash scripts/release.sh "$GITHUB_REF_NAME" "$RUNNER_TEMP/packs"');
    expect(PUBLISH_JOB).toContain("npm install -g npm@11.21.1");
    expect(PUBLISH_JOB).toContain("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&event=push&status=success");
    expect(PUBLISH_JOB).not.toContain("continue-on-error");
  });

  it("names the release after the tag, with the commit titles since the previous version tag", () => {
    const run = githubRelease("v0.1.1");
    expect(run.code).toBe(0);
    const create = run.log.join("\n");
    expect(create).toContain("gh release create v0.1.1 --verify-tag --title v0.1.1 --notes - third change\n- second change");
    expect(create).not.toContain("first change");
  });

  it("does not create a second release when the tag already has one", () => {
    const run = githubRelease("v0.1.1", ["v0.1.1"]);
    expect(run.code).toBe(0);
    expect(run.log.filter((line) => line.startsWith("gh release create"))).toEqual([]);
  });

  it("fails visibly when the release cannot be created, and refuses a malformed tag", () => {
    expect(githubRelease("v0.1.1", [], true).code).not.toBe(0);
    expect(githubRelease("0.1.1").code).toBe(1);
    expect(githubRelease("v0.1.1-rc.1").code).toBe(1);
  });
});
