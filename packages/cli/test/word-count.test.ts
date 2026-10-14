import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const JOB = join(ROOT, "examples/jobs/word-count");

function check(artifact: string) {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "", ARTIFACT_PATH: artifact, SPEC_PATH: join(JOB, "SPEC.md") };
  return spawnSync(process.execPath, [join(JOB, "check.mjs")], { encoding: "utf8", env });
}

describe("the word count example job", () => {
  it("the word count check accepts the committed delivery", () => {
    const directory = check(join(JOB, "delivery"));
    expect(directory.stderr).toBe("");
    expect(directory.stdout.trim()).toBe("8 of 8 rows hold");
    expect(directory.status).toBe(0);
    expect(check(join(JOB, "delivery/wordcount.mjs")).status).toBe(0);
  });

  it("the word count check refuses a wrong delivery", () => {
    const dir = mkdtempSync(join(tmpdir(), "word-count-"));
    writeFileSync(join(dir, "wordcount.mjs"), 'export default function count(text) {\n  return text.split(" ").filter(Boolean).length;\n}\n');
    const wrong = check(dir);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('count("tabs\\tand\\nnew lines") returned 2, expected 4');
    expect(wrong.stdout.trim()).toBe("6 of 8 rows hold");
    writeFileSync(join(dir, "none.mjs"), "export const count = 1;\n");
    expect(check(join(dir, "none.mjs")).status).toBe(1);
  });
});
