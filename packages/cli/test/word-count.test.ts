import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const JOB = join(ROOT, "examples/jobs/word-count");
const CORRECT = readFileSync(join(JOB, "delivery/wordcount.mjs"), "utf8");

function check(artifact: string) {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", ARTIFACT_PATH: artifact, SPEC_PATH: join(JOB, "SPEC.md") };
  return spawnSync(process.execPath, [join(JOB, "check.mjs")], { encoding: "utf8", env });
}

function delivery(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "word-count-"));
  writeFileSync(join(dir, "wordcount.mjs"), source);
  return dir;
}

function refused(source: string) {
  const result = check(delivery(source));
  expect(result.status).toBe(1);
  expect(result.stdout).not.toMatch(/^(\d+) of \1 inputs hold$/m);
  return result;
}

describe("the word count example job", () => {
  it("the word count check accepts the committed delivery", () => {
    const directory = check(join(JOB, "delivery"));
    expect(directory.stderr).toBe("");
    expect(directory.stdout.trim()).toBe("32 of 32 inputs hold");
    expect(directory.status).toBe(0);
    expect(check(join(JOB, "delivery/wordcount.mjs")).status).toBe(0);
  });

  it("the word count check refuses a wrong delivery", () => {
    const dir = delivery('export default function count(text) {\n  return text.split(" ").filter(Boolean).length;\n}\n');
    const wrong = check(dir);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('count("tabs\\tand\\nnew lines") returned 2, expected 4');
    expect(wrong.stdout.trim()).toMatch(/^\d+ of 32 inputs hold$/);
    writeFileSync(join(dir, "none.mjs"), "export const count = 1;\n");
    const none = check(join(dir, "none.mjs"));
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("has no default export function");
  });

  it("the word count check refuses a delivery that exits early", () => {
    refused("process.exit(0);\n");
    refused(`${CORRECT}process.stdin.on("end", () => process.exit(0));\n`);
    refused(`${CORRECT}process.exitCode = 3;\n`);
  });

  it("the word count check refuses a delivery that prints the success line", () => {
    refused('console.log("32 of 32 inputs hold");\nprocess.exit(0);\n');
    refused(`${CORRECT}console.log("32 of 32 inputs hold");\n`);
    refused(`${CORRECT}console.error("32 of 32 inputs hold");\n`);
    refused(`${CORRECT}process.stdout.write("[]\\n");\n`);
  });

  it("the word count check refuses a delivery that only knows the table", () => {
    const table = JSON.stringify([["", 0], ["   ", 0], ["one", 1], ["two words", 2], ["  leading and trailing  ", 3], ["tabs\tand\nnew lines", 4], ["a b", 2], ["a  b   c", 3]]);
    const result = refused(`const table = new Map(${table});\nexport default function count(text) {\n  return table.get(text) ?? 0;\n}\n`);
    expect(result.stdout.trim()).toBe("8 of 32 inputs hold");
  });

  it("the word count check stops a delivery that never finishes", () => {
    const result = refused("while (true) {}\n");
    expect(result.stderr).toContain("did not finish within 10 s");
  }, 20_000);
});
