import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { loadAnnouncement } from "@intent-engine/client/internal";
import { ENV_KEYPAIR, JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, RUN_NEEDED } from "../src/args.js";
import {
  artifactSha256,
  WAIT_FOR_NODE,
  CHECK_ENV,
  checkEnv,
  ENV_ARTIFACT_PATH,
  ENV_ARTIFACT_SHA256,
  ENV_SPEC_PATH,
  SPEC_COPY,
  SKIPPED,
} from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { announced as announce } from "./announce.js";
import { cli, h, transport } from "./harness.js";
import { job, type Job, judging, SPEC, status, STOLEN_URL, WORK_URL } from "./judge-kit.js";

describe("intent-engine judge", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("the check sees no target or node_modules directory", async () => {
    const check = [
      `test "$ARTIFACT_PATH" != "${j.artifact}"`,
      ...[...SKIPPED].map((skipped) => `test ! -e "$ARTIFACT_PATH/${skipped}"`),
      'test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42',
      'test "$(cat "$ARTIFACT_PATH/src/notes.txt")" = how',
      `test "$(find "$ARTIFACT_PATH" -type f | wc -l)" -eq 2`,
    ].join(" && ");
    const run = await cli(judging(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", artifactSha256: j.sha256 });
    expect(existsSync(join(j.artifact, "target", "ignored"))).toBe(true);
  });

  it("the check environment holds only allowlisted variables", async () => {
    const base = { PATH: "/bin", HOME: "/h", TERM: "xterm", INTENT_ENGINE_URL: "https://x/?api-key=s", [ENV_KEYPAIR]: "/k", NPM_TOKEN: "t" };
    expect(checkEnv(base, "/s", "/a", "ab")).toEqual({ PATH: "/bin", HOME: "/h", TERM: "xterm", [ENV_SPEC_PATH]: "/s", [ENV_ARTIFACT_PATH]: "/a", [ENV_ARTIFACT_SHA256]: "ab" });
    expect(CHECK_ENV).toEqual(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"]);
    const secrets = { INTENT_ENGINE_URL: "https://x/?api-key=s", [ENV_KEYPAIR]: "judge.json", JUDGE_TEST_SECRET: "s" };
    Object.assign(process.env, secrets);
    const run = await cli(judging(j, Object.keys(secrets).map((key) => `test -z "$${key}"`).join(" && ")), keys);
    for (const key of Object.keys(secrets)) {
      delete process.env[key];
    }
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass" });
  });

  it("the artifact copy is removed after the check", async () => {
    const seen = join(j.dir, "seen");
    for (const [ending, code] of [["true", EXIT_OK], ["exit 5", EXIT_FAILED]] as const) {
      const run = await cli(judging(j, `echo "$ARTIFACT_PATH" > "${seen}" && test -f "$ARTIFACT_PATH/answer.txt" && ${ending}`), keys);
      expect(run.code).toBe(code);
      const copy = (await readFile(seen, "utf8")).trim();
      expect(copy).not.toBe(j.artifact);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(j.artifact, "answer.txt"))).toBe(true);
    }
  });

  it("a single file artifact keeps its plain sha256", async () => {
    const file = join(j.dir, "answer.txt");
    await writeFile(file, "42\n");
    const sha256 = createHash("sha256").update("42\n").digest("hex");
    expect(await artifactSha256(file)).toBe(sha256);
    await announce(j.intent, j.worker, sha256, WORK_URL);
    const seen = join(j.dir, "seen");
    const check = `echo "$ARTIFACT_PATH" > "${seen}" && test "$ARTIFACT_SHA256" = ${sha256} && test "$ARTIFACT_PATH" != "${file}" && test "$(cat "$ARTIFACT_PATH")" = 42`;
    const run = await cli(judging({ ...j, artifact: file }, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", artifactSha256: sha256, payTo: j.worker.address });
    expect(existsSync((await readFile(seen, "utf8")).trim())).toBe(false);
  });

  it("the copy keeps executable bits", async () => {
    await writeFile(join(j.artifact, "test.sh"), '#!/bin/sh\ntest "$(cat "$(dirname "$0")/answer.txt")" = 42\n');
    await chmod(join(j.artifact, "test.sh"), 0o750);
    await chmod(join(j.artifact, "answer.txt"), 0o644);
    const check = [
      '"$ARTIFACT_PATH/test.sh"',
      'test -x "$ARTIFACT_PATH/test.sh"',
      'test ! -x "$ARTIFACT_PATH/answer.txt"',
      'test ! -x "$ARTIFACT_PATH/src/notes.txt"',
      'test "$(stat -c %a "$ARTIFACT_PATH/test.sh")" = "$(printf %o $(( 0$(stat -c %a "$ARTIFACT_PATH/answer.txt") | 0110 )))"',
    ].join(" && ");
    await announce(j.intent, j.worker, await artifactSha256(j.artifact), "https://" + "example.org/with-test.tar");
    const run = await cli(judging(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", artifactSha256: await artifactSha256(j.artifact), payTo: j.worker.address });
    expect((await stat(join(j.artifact, "test.sh"))).mode & 0o777).toBe(0o750);
  });

  it("spec path points at a copy of the hashed spec", async () => {
    const seen = join(j.dir, "seen");
    const check = [
      `echo "$SPEC_PATH" > "${seen}"`,
      `test "$SPEC_PATH" != "${j.spec}"`,
      `test "$(basename "$SPEC_PATH")" = ${SPEC_COPY}`,
      'case "$SPEC_PATH" in "$ARTIFACT_PATH"/?*) false ;; esac',
      `echo tampered > "${j.spec}"`,
      `test "$(cat "$SPEC_PATH")" = "${SPEC.trim()}"`,
      `test "$(find "$ARTIFACT_PATH" -type f | wc -l)" -eq 2`,
    ].join(" && ");
    const run = await cli(judging(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", specHash: createHash("sha256").update(SPEC).digest("hex") });
    expect(await readFile(j.spec, "utf8")).toBe("tampered\n");
    expect(existsSync((await readFile(seen, "utf8")).trim())).toBe(false);
  });

  it("the check runs in the copy", async () => {
    const seen = join(j.dir, "seen");
    const check = [
      `pwd -P > "${seen}"`,
      `test "$(pwd -P)" != "$(cd "${process.cwd()}" && pwd -P)"`,
      'test "$(cd "$ARTIFACT_PATH/.." && pwd -P)" = "$(pwd -P)"',
      'test "$(cd "$(dirname "$SPEC_PATH")/.." && pwd -P)" = "$(pwd -P)"',
    ].join(" && ");
    const run = await cli(judging(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass" });
    expect(run.json()).not.toHaveProperty("cleanup");
    expect(existsSync((await readFile(seen, "utf8")).trim())).toBe(false);
  });

  it("takes a timeout within bounds and a non-empty command", async () => {
    expect(JUDGE_TIMEOUT).toBeLessThanOrEqual(MAX_JUDGE_TIMEOUT);
    for (const timeout of ["0", String(MAX_JUDGE_TIMEOUT + 1), "1.5"]) {
      expect((await cli(judging(j, "true", "--timeout", timeout), keys)).code).toBe(EXIT_USAGE);
    }
    expect(await cli(judging(j, " "), keys)).toMatchObject({ code: EXIT_USAGE, err: RUN_NEEDED });
  });

  it("lists the announcements of an escrow in seq order with their state, and their urls only to a judge key", async () => {
    const second = await loadAnnouncement(transport, (await createClient({ url: "http://cluster", transport }).announcements(j.intent)).announcements[1]?.address ?? j.intent);
    const listed = [
      { announcement: j.first.announcement, seq: "1", worker: j.worker.address, state: "announced", commitment: j.first.commitment },
      { announcement: second?.address, seq: "2", worker: j.copier.address, state: "announced", commitment: Buffer.from(second?.commitment ?? []).toString("hex") },
    ];
    const plain = (await cli(["deliveries", "--intent", j.intent], {})).json();
    expect(plain).toMatchObject({ intent: j.intent, complete: true, closed: false, next_seq: "3", missing: [], announcements: listed });
    expect((plain["announcements"] as Record<string, unknown>[]).some((line) => "url" in line)).toBe(false);
    expect((await cli(["deliveries", "--intent", j.intent, "--judge-keypair", "judge.json"], keys)).json()).toMatchObject({
      announcements: [
        { ...listed[0], url: WORK_URL },
        { ...listed[1], url: STOLEN_URL },
      ],
    });
  });

  it("refuses with what to do next while the node does not list every announcement", async () => {
    const marker = join(j.dir, "ran");
    const hiding: Transport = { ...transport, engineAccounts: async (filter) => ((await transport.engineAccounts?.(filter)) ?? []).filter(({ address }) => address !== j.first.announcement) };
    h.through = hiding;
    const refused = await cli(judging(j, `touch "${marker}"`, "--yes"), keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("lists its announcements with seq 1 missing");
    expect(refused.err).toContain(WAIT_FOR_NODE);
    expect(existsSync(marker)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect((await cli(["deliveries", "--intent", j.intent], {})).json()).toMatchObject({ complete: false, missing: ["1"] });
  });
});
