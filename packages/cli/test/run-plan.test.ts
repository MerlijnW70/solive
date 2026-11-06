import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/args.js";
import { readArtifact } from "../src/artifact.js";
import type { JudgeCommand } from "../src/judge.js";
import { JudgeRefused } from "../src/judge-errors.js";
import { checkFilesSha256, RUN_OVERHEAD_SECONDS } from "../src/judge-run.js";
import { CHECK_UNPINNED, checkDiffers, checkEmpty, checkFilesOf, checkNeeded, differs, GPU_REFUSED, limitsOf, NOT_DOCKER, runPlan, timeoutShort, unpinned } from "../src/run-plan.js";
import { SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, SANDBOX_TMP } from "../src/sandbox.js";

const OWNER = "11111111111111111111111111111111";
const OTHER_IMAGE = `busybox@sha256:${"cd".repeat(32)}`;
const RUN = "node check/check.mjs";
const BLOCK = { image: SANDBOX_IMAGE, run: RUN, timeout: 60 };
const spec = (fields?: object) => new TextEncoder().encode(`# Job\n\n${fields === undefined ? "" : `\`\`\`judge-run\n${JSON.stringify(fields)}\n\`\`\`\n`}`);
const judging = (...more: string[]) => parse(["judge", "--keypair", "judge.json", "--owner", OWNER, "--nonce", "0", "--spec", "spec.md", "--artifact", "work", ...more]) as JudgeCommand;
const refused = (option: string, why: string) => `${option} ${why}; nothing was run or paid`;
const BOX = { image: SANDBOX_IMAGE, memory: SANDBOX_MEMORY, cpus: SANDBOX_CPUS, tmp: SANDBOX_TMP, gpu: false };

const refusalOf = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    expect(error).toBeInstanceOf(JudgeRefused);
    return (error as Error).message;
  }
  return "accepted";
};

describe("runPlan without a judge-run block", () => {
  it("returns the judge's own options untouched, whatever they are", () => {
    for (const argv of [
      ["--run", "true"],
      ["--run", " anything at all ", "--timeout", "5", "--sandbox-image", OTHER_IMAGE, "--sandbox-memory", "64m", "--sandbox-cpus", "0.5", "--sandbox-tmp", "8m", "--sandbox-gpu"],
      ["--sandbox", "viper"],
      ["--sandbox", "viper", "--plain-node", "--sandbox-memory", "2g"],
      ["--sandbox", "none", "--i-trust-this-work", "--run", "exit 0"],
    ]) {
      const command = judging(...argv);
      expect(runPlan(spec(), command), argv.join(" ")).toEqual({ sandbox: command.sandbox, run: command.run, timeout: command.timeout });
    }
  });
});

describe("runPlan with a judge-run block", () => {
  const pinned = { ...BLOCK, memory: "512m", cpus: "1.5" };

  it("takes every value the judge left out from the block, and its timeout plus the judge's overhead", () => {
    expect(runPlan(spec(pinned), judging("--run", RUN))).toEqual({
      sandbox: { kind: "docker", image: SANDBOX_IMAGE, memory: "512m", cpus: "1.5", tmp: SANDBOX_TMP, gpu: false },
      run: RUN,
      timeout: 60 + RUN_OVERHEAD_SECONDS,
      pinned,
    });
    expect(runPlan(spec(BLOCK), judging("--run", RUN)).sandbox).toEqual({ kind: "docker", ...BOX });
  });

  it("accepts each option equal to the block and refuses each that differs, naming it", () => {
    const table: [string[], string][] = [
      [["--sandbox", "docker"], "accepted"],
      [["--sandbox", "viper"], refused("--sandbox viper", NOT_DOCKER)],
      [["--sandbox", "viper", "--plain-node"], refused("--sandbox viper", NOT_DOCKER)],
      [["--sandbox", "none", "--i-trust-this-work"], refused("--sandbox none", NOT_DOCKER)],
      [["--sandbox-image", SANDBOX_IMAGE], "accepted"],
      [["--sandbox-image", OTHER_IMAGE], refused("--sandbox-image", differs(OTHER_IMAGE, SANDBOX_IMAGE, "the image"))],
      [["--sandbox-image", `docker.io/library/${SANDBOX_IMAGE}`], refused("--sandbox-image", differs(`docker.io/library/${SANDBOX_IMAGE}`, SANDBOX_IMAGE, "the image"))],
      [["--sandbox-memory", "512m"], "accepted"],
      [["--sandbox-memory", "1g"], refused("--sandbox-memory", differs("1g", "512m", "the memory"))],
      [["--sandbox-memory", "511m"], refused("--sandbox-memory", differs("511m", "512m", "the memory"))],
      [["--sandbox-cpus", "1.5"], "accepted"],
      [["--sandbox-cpus", "1.50"], "accepted"],
      [["--sandbox-cpus", "1"], refused("--sandbox-cpus", differs("1", "1.5", "the CPUs"))],
      [["--sandbox-tmp", SANDBOX_TMP], "accepted"],
      [["--sandbox-tmp", "1m"], refused("--sandbox-tmp", unpinned("1m", SANDBOX_TMP, "/tmp"))],
      [["--sandbox-gpu"], refused("--sandbox-gpu", GPU_REFUSED)],
      [["--timeout", String(60 + RUN_OVERHEAD_SECONDS)], "accepted"],
      [["--timeout", "86400"], "accepted"],
      [["--timeout", String(59 + RUN_OVERHEAD_SECONDS)], refused("--timeout", timeoutShort(59 + RUN_OVERHEAD_SECONDS, 60))],
      [["--timeout", "60"], refused("--timeout", timeoutShort(60, 60))],
    ];
    for (const [argv, expected] of table) {
      const run = argv.includes("viper") ? [] : ["--run", RUN];
      expect(refusalOf(() => runPlan(spec(pinned), judging(...run, ...argv))), argv.join(" ")).toBe(expected);
    }
    expect(runPlan(spec(pinned), judging("--run", RUN, "--timeout", "900")).timeout).toBe(900);
  });

  it("refuses a --run that differs by a byte, whitespace included", () => {
    for (const run of [`${RUN} `, ` ${RUN}`, "node  check/check.mjs", "node check/check.mjs;", "node ./check/check.mjs", "true"]) {
      expect(refusalOf(() => runPlan(spec(pinned), judging("--run", run))), run).toBe(refused("--run", differs(run, RUN, "the run")));
    }
  });

  it("holds options the block leaves out to the judge's defaults, refusing any other value", () => {
    const table: [string[], string][] = [
      [["--sandbox-memory", SANDBOX_MEMORY], "accepted"],
      [["--sandbox-memory", "1024m"], "accepted"],
      [["--sandbox-memory", "2g"], refused("--sandbox-memory", unpinned("2g", SANDBOX_MEMORY, "memory"))],
      [["--sandbox-memory", "16m"], refused("--sandbox-memory", unpinned("16m", SANDBOX_MEMORY, "memory"))],
      [["--sandbox-cpus", SANDBOX_CPUS], "accepted"],
      [["--sandbox-cpus", "0.01"], refused("--sandbox-cpus", unpinned("0.01", SANDBOX_CPUS, "the CPUs"))],
    ];
    for (const [argv, expected] of table) {
      expect(refusalOf(() => runPlan(spec(BLOCK), judging("--run", RUN, ...argv))), argv.join(" ")).toBe(expected);
    }
  });

  it("compares every option when the caller does not say which were given", () => {
    const command = judging("--run", RUN);
    const { given: _given, ...programmatic } = command;
    expect(runPlan(spec(BLOCK), programmatic).timeout).toBe(command.timeout);
    expect(refusalOf(() => runPlan(spec({ ...BLOCK, image: OTHER_IMAGE }), programmatic))).toBe(refused("--sandbox-image", differs(SANDBOX_IMAGE, OTHER_IMAGE, "the image")));
    expect(refusalOf(() => runPlan(spec({ ...BLOCK, timeout: command.timeout }), programmatic))).toBe(refused("--timeout", timeoutShort(command.timeout, command.timeout)));
  });

  it("gives the pinned limits to the classifier, and only the limits the block pins", () => {
    expect(limitsOf(runPlan(spec(pinned), judging("--run", RUN)))).toEqual({ seconds: 60 + RUN_OVERHEAD_SECONDS, memory: "512m", pinned: { seconds: 60, memory: "512m" } });
    expect(limitsOf(runPlan(spec(BLOCK), judging("--run", RUN)))).toEqual({ seconds: 60 + RUN_OVERHEAD_SECONDS, memory: SANDBOX_MEMORY, pinned: { seconds: 60, memory: undefined } });
    expect(limitsOf(runPlan(spec(), judging("--run", RUN, "--timeout", "7")))).toEqual({ seconds: 7, memory: SANDBOX_MEMORY });
  });
});

describe("checkFilesOf", () => {
  async function files() {
    const root = await mkdtemp(join(tmpdir(), "run-plan-"));
    const check = join(root, "check.mjs");
    await writeFile(check, "process.exit(0);\n");
    await chmod(check, 0o644);
    const dir = join(root, "tests");
    await mkdir(dir);
    await writeFile(join(dir, "a.mjs"), "x");
    const sha256 = await checkFilesSha256({ name: "check.mjs", read: await readArtifact(check) });
    return { root, check, dir, sha256 };
  }

  it("reads --check as today without a block, and nothing without --check", async () => {
    const { check } = await files();
    const plain = runPlan(spec(), judging("--run", "true"));
    expect(await checkFilesOf(undefined, plain)).toBeUndefined();
    const read = await checkFilesOf(check, plain);
    expect(read).toEqual({ name: "check.mjs", read: await readArtifact(check) });
  });

  it("needs --check when the block pins check_sha256, refuses one that hashes otherwise, and refuses one the block does not pin", async () => {
    const { check, dir, sha256 } = await files();
    const pinned = runPlan(spec({ ...BLOCK, check_sha256: sha256 }), judging("--run", RUN));
    await expect(checkFilesOf(undefined, pinned)).rejects.toThrow(refused("--check", checkNeeded(sha256)));
    const other = await checkFilesSha256({ name: basename(dir), read: await readArtifact(dir) });
    await expect(checkFilesOf(dir, pinned)).rejects.toThrow(refused("--check", checkDiffers(dir, other, `check_sha256 ${sha256}`)));
    const unpinnedPlan = runPlan(spec(BLOCK), judging("--run", RUN));
    await expect(checkFilesOf(check, unpinnedPlan)).rejects.toThrow(refused("--check", CHECK_UNPINNED));
    expect(await checkFilesOf(undefined, unpinnedPlan)).toBeUndefined();
  });

  it("refuses an empty check directory under a block, since its hash would not name what is mounted", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-plan-"));
    const empty = join(root, "empty");
    await mkdir(empty);
    const plan = runPlan(spec({ ...BLOCK, check_sha256: "ab".repeat(32) }), judging("--run", RUN));
    await expect(checkFilesOf(empty, plan)).rejects.toThrow(refused("--check", checkEmpty(empty)));
    expect(await checkFilesOf(empty, runPlan(spec(), judging("--run", RUN)))).toMatchObject({ name: "empty", read: { entries: [] } });
  });

  it("mounts the very bytes it hashed, every file executable, under the name it hashed", async () => {
    const { check, sha256 } = await files();
    const read = await checkFilesOf(check, runPlan(spec({ ...BLOCK, check_sha256: sha256 }), judging("--run", RUN)));
    expect(read?.name).toBe("check.mjs");
    expect(read?.read.entries.map((entry) => [entry.path, new TextDecoder().decode(entry.bytes), entry.executable])).toEqual([["check.mjs", "process.exit(0);\n", 0o111]]);
    expect(await checkFilesSha256(read as NonNullable<typeof read>)).toBe(sha256);
  });
});
