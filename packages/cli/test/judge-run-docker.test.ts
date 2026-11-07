import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { readArtifact } from "../src/artifact.js";
import { EXIT_REFUSED, EXIT_RETRY, INFRA_NEXT, oomInfra, oomInfraUnpinned } from "../src/judge-errors.js";
import { checkFilesSha256, RUN_OVERHEAD_SECONDS } from "../src/judge-run.js";
import { checkDiffers, differs } from "../src/run-plan.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { SANDBOX_IMAGE, SANDBOX_MEMORY } from "../src/sandbox.js";
import { oomPinned, ranPastPin } from "../src/verdict-model.js";
import { cli } from "./harness.js";
import { boxed, job, type Job, paidTo, status } from "./judge-kit.js";

const DOCKER_UP = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
const LIVE = { timeout: 180_000 } as const;
const CHECK = 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync(process.env.ARTIFACT_PATH + "/answer.txt", "utf8").trim() === "42" ? 0 : 1);\n';
const RUN = "test -x check/check.mjs && node check/check.mjs";
const BOMB = "node -e 'const kept = []; for (;;) kept.push(Buffer.alloc(16 << 20, 1))'";
const specWith = (fields: object) => `# Answer\n\nanswer.txt holds 42.\n\n\`\`\`judge-run\n${JSON.stringify(fields)}\n\`\`\`\n`;
const infra = (reason: string) => `infrastructure error, not a verdict: ${reason}; ${INFRA_NEXT}`;

async function pinnedJob(fields: object, check = CHECK): Promise<{ j: Job; check: string; verdict: string }> {
  const probeCheck = join(await mkdtemp(join(tmpdir(), "pinned-check-")), "check.mjs");
  await writeFile(probeCheck, check);
  const sha256 = await checkFilesSha256({ name: "check.mjs", read: await readArtifact(probeCheck) });
  const j = await job(specWith({ ...fields, check_sha256: sha256 }));
  const path = join(j.dir, "check.mjs");
  await writeFile(path, check);
  return { j, check: path, verdict: join(j.dir, "verdict.json") };
}

describe("judge under a judge-run block, in a real Docker container", () => {
  it("has Docker to run these tests, and fails loudly without it", () => {
    expect(DOCKER_UP, "docker version failed: start Docker, since the pinned-check tests must run").toBe(true);
  });

  it("signs a pinned check that passes, running exactly its image, command and executable check files", LIVE, async () => {
    const { j, check, verdict } = await pinnedJob({ image: SANDBOX_IMAGE, run: RUN, timeout: 60, memory: "256m", cpus: "1" });
    const paid = await cli(boxed(j, RUN, "--check", check, "--verdict", verdict, "--yes"), { "judge.json": j.judge });
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE, command: RUN, exitCode: 0, signature: expect.any(String), judgeRun: { run: RUN, timeout: 60, memory: "256m", cpus: "1" } });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toMatchObject({ verdict: "pass" });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
  });

  it("fails and does not sign a pinned check that kills itself with signal 9, which work run by the check can always do", LIVE, async () => {
    for (const run of ["node -e 'process.kill(process.pid, \"SIGKILL\")'", "exit 137"]) {
      const { j, check, verdict } = await pinnedJob({ image: SANDBOX_IMAGE, run, timeout: 60, memory: "256m" });
      const killed = await cli(boxed(j, run, "--check", check, "--sandbox-memory", "256m", "--verdict", verdict, "--yes"), { "judge.json": j.judge });
      expect([killed.code, killed.err], run).toEqual([EXIT_FAILED, ""]);
      expect(killed.json(), run).toMatchObject({ verdict: "fail", exitCode: 137, signature: null });
      expect(existsSync(verdict), run).toBe(true);
      expect(status(j.intent), run).toBe(IntentStatus.Open);
    }
  });

  it("fails and does not sign a check that runs past its pinned timeout, whether it ends by itself or is still running and stopped", LIVE, async () => {
    for (const [run, more] of [
      ["sleep 3; node check/check.mjs", []],
      ["sleep 600", ["--timeout", String(1 + RUN_OVERHEAD_SECONDS)]],
    ] as const) {
      const { j, check, verdict } = await pinnedJob({ image: SANDBOX_IMAGE, run, timeout: 1 });
      const late = await cli(boxed(j, run, "--check", check, "--verdict", verdict, "--yes", ...more), { "judge.json": j.judge });
      expect([late.code, late.err], run).toEqual([EXIT_FAILED, ""]);
      expect(late.json(), run).toMatchObject({ verdict: "fail", signature: null });
      expect(existsSync(verdict), run).toBe(true);
      expect(status(j.intent), run).toBe(IntentStatus.Open);
      expect(await paidTo(j, j.worker.address), run).toBe(-1n);
    }
    expect(ranPastPin(1)).toContain("1 second timeout");
  });

  it("fails a container killed for its pinned memory, and keeps a judge-chosen memory limit infra", LIVE, async () => {
    const pinned = await pinnedJob({ image: SANDBOX_IMAGE, run: BOMB, timeout: 60, memory: "64m" });
    const failed = await cli(boxed(pinned.j, BOMB, "--check", pinned.check, "--verdict", pinned.verdict, "--yes"), { "judge.json": pinned.j.judge });
    expect([failed.code, failed.err]).toEqual([EXIT_FAILED, ""]);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null });
    expect(status(pinned.j.intent)).toBe(IntentStatus.Open);
    expect(oomPinned("64m")).toContain("64m");

    const chosen = await pinnedJob({ image: SANDBOX_IMAGE, run: BOMB, timeout: 120 });
    const stalled = await cli(boxed(chosen.j, BOMB, "--check", chosen.check, "--verdict", chosen.verdict, "--yes"), { "judge.json": chosen.j.judge });
    expect([stalled.code, stalled.out, stalled.err]).toEqual([EXIT_RETRY, "", infra(oomInfraUnpinned(SANDBOX_MEMORY))]);
    expect(existsSync(chosen.verdict)).toBe(false);
    expect(status(chosen.j.intent)).toBe(IntentStatus.Open);
  });

  it("refuses a --run that differs and a --check whose hash differs, before anything runs", LIVE, async () => {
    const { j, check, verdict } = await pinnedJob({ image: SANDBOX_IMAGE, run: RUN, timeout: 60 });
    const run = await cli(boxed(j, "true", "--check", check, "--verdict", verdict, "--yes"), { "judge.json": j.judge });
    expect([run.code, run.out, run.err]).toEqual([EXIT_REFUSED, "", `--run ${differs("true", RUN, "the run")}; nothing was run or paid`]);
    const pinned = (await readFile(j.spec, "utf8")).match(/"check_sha256":"([0-9a-f]{64})"/)?.[1] ?? "";
    await writeFile(check, "process.exit(0);\n");
    const other = await checkFilesSha256({ name: "check.mjs", read: await readArtifact(check) });
    const swapped = await cli(boxed(j, RUN, "--check", check, "--verdict", verdict, "--yes"), { "judge.json": j.judge });
    expect([swapped.code, swapped.out, swapped.err]).toEqual([EXIT_REFUSED, "", `--check ${checkDiffers(check, other, `check_sha256 ${pinned}`)}; nothing was run or paid`]);
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("judges a spec without a block exactly as before: the judge's own command and limits, and its memory limit infra", LIVE, async () => {
    const j = await job();
    const passed = await cli(boxed(j, "true", "--sandbox-memory", "256m", "--sandbox-cpus", "0.5", "--timeout", "30"), { "judge.json": j.judge });
    expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
    expect(passed.json()).toMatchObject({ verdict: "pass", command: "true", signature: null });
    expect(passed.json()).not.toHaveProperty("judgeRun");
    const failed = await cli(boxed(j, "sleep 2; exit 4", "--timeout", "30"), { "judge.json": j.judge });
    expect([failed.code, failed.json()["exitCode"]]).toEqual([EXIT_FAILED, 4]);
    const stalled = await cli(boxed(j, BOMB, "--sandbox-memory", "64m"), { "judge.json": j.judge });
    expect([stalled.code, stalled.err]).toEqual([EXIT_RETRY, infra(oomInfra("64m"))]);
  });
});
