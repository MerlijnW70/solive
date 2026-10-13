import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, type Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { deliveryMemo, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, manifestSha256, RELEASE_MEMO_PREFIX, releaseMemo } from "@intent-engine/core";
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { ENV_KEYPAIR, JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, RUN_NEEDED } from "../src/args.js";
import { NOT_SENT } from "../src/flows.js";
import { artifactSha256, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH, runCheck, SKIPPED } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { balance, cli, funded, h, NOW, transport, type World, world } from "./harness.js";

const SPEC = "answer.txt holds 42\n";
const WORK_URL = "https://example.org/work.tar";
const TIMEOUT_SECONDS = 1;

type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; copier: KeyPairSigner; intent: Address; dir: string; spec: string; artifact: string; sha256: string };

const announced = (intent: Address, by: Address, sha256: string, signature: string, slot: bigint, url = WORK_URL): EngineTransaction => ({
  signature,
  slot,
  blockTime: null,
  failed: false,
  emitted: [],
  memos: [deliveryMemo({ intent, sha256, url })],
  feePayer: by,
});

async function job(): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await generateKeyPairSigner();
  const copier = await generateKeyPairSigner();
  const dir = await mkdtemp(join(tmpdir(), "judge-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, SPEC);
  const artifact = join(dir, "work");
  for (const skipped of [".git", "node_modules", "target"]) {
    await mkdir(join(artifact, skipped), { recursive: true });
    await writeFile(join(artifact, skipped, "ignored"), "not hashed");
  }
  await mkdir(join(artifact, "src"), { recursive: true });
  await writeFile(join(artifact, "answer.txt"), "42\n");
  await writeFile(join(artifact, "src", "notes.txt"), "how\n");
  const sha256 = await manifestSha256([
    { path: "answer.txt", bytes: new TextEncoder().encode("42\n") },
    { path: "src/notes.txt", bytes: new TextEncoder().encode("how\n") },
  ]);
  const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [announced(intent, copier.address, sha256, "copy", 9n, "https://example.org/stolen"), announced(intent, worker.address, sha256, "first", 5n)];
  return { w, judge, worker, copier, intent, dir, spec, artifact, sha256 };
}

const judging = (j: Job, run: string, ...more: string[]) => [
  "judge",
  "--keypair",
  "judge.json",
  "--owner",
  j.w.owner.address,
  "--nonce",
  "0",
  "--spec",
  j.spec,
  "--artifact",
  j.artifact,
  "--run",
  run,
  ...more,
];

const paidTo = async (j: Job, wallet: Address) =>
  balance(await findAssociatedTokenAddress({ owner: wallet, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

describe("intent-engine judge", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("runs the operator's check with the spec, artifact and hash in its environment, then pays the earliest announcer, not a copier", async () => {
    const verdict = join(j.dir, "verdict.json");
    const check = `test "$ARTIFACT_SHA256" = ${j.sha256} && test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42 && grep -q 42 "$SPEC_PATH" && test -z "$${ENV_KEYPAIR}"`;
    process.env[ENV_KEYPAIR] = "judge.json";
    const preview = await cli(judging(j, check, "--verdict", verdict), keys);
    delete process.env[ENV_KEYPAIR];
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const shown = {
      intent: j.intent,
      specHash: createHash("sha256").update(SPEC).digest("hex"),
      artifactSha256: j.sha256,
      command: check,
      exitCode: 0,
      verdict: "pass",
      payTo: j.worker.address,
      signature: null,
    };
    expect(preview.json()).toEqual({ ...shown, next: NOT_SENT });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(preview.json());
    expect(await paidTo(j, j.worker.address)).toBe(-1n);

    const sent = await cli(judging(j, check, "--verdict", verdict, "--yes"), keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toEqual({ ...shown, signature: expect.any(String) });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(sent.json());
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    expect(await paidTo(j, j.copier.address)).toBe(-1n);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    const landed = h.svm.getTransaction(sent.json()["signature"] as Signature);
    if (!(landed instanceof TransactionMetadata)) {
      throw new Error("the settle did not land");
    }
    expect(landed.logs().some((line) => line.includes(releaseMemo(j.sha256)))).toBe(true);
  });

  it("fails, sends nothing and exits non-zero when the check exits non-zero", async () => {
    const failed = await cli(judging(j, "exit 3", "--yes"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ exitCode: 3, verdict: "fail", payTo: j.worker.address, signature: null });
    expect(failed.json()).not.toHaveProperty("next");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("fails a check that outlives --timeout and kills its whole process tree", async () => {
    const pid = join(j.dir, "pid");
    const started = Date.now();
    const slow = await cli(judging(j, `sleep 600 & echo $! > "${pid}"; wait`, "--timeout", String(TIMEOUT_SECONDS), "--yes"), keys);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_SECONDS * 1000 * 10);
    expect(slow.code).toBe(EXIT_FAILED);
    expect(slow.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null });
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const child = Number(await readFile(pid, "utf8"));
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let tries = 0; tries < 50 && alive(); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive()).toBe(false);
  });

  it("refuses before running anything when the spec differs from the committed hash, nobody announced the artifact, --pay-to is not its earliest announcer, or the keypair is not the judge", async () => {
    const marker = join(j.dir, "ran");
    const run = `touch "${marker}"`;
    await writeFile(join(j.dir, "other.md"), "a different spec\n");
    const mismatch = await cli([...judging(j, run).slice(0, 7), "--spec", join(j.dir, "other.md"), ...judging(j, run).slice(9)], keys);
    expect(mismatch.code).toBe(EXIT_FAILED);
    expect(mismatch.err).toContain(`but intent ${j.intent} commits ${createHash("sha256").update(SPEC).digest("hex")}`);

    const conflict = await cli(judging(j, run, "--pay-to", j.copier.address, "--yes"), keys);
    expect(conflict.code).toBe(EXIT_FAILED);
    expect(conflict.err).toContain(`${j.worker.address} announced the artifact with sha256 ${j.sha256} first, in first`);

    const stranger = await funded();
    const foreign = await cli(judging(j, run), { "judge.json": stranger });
    expect(foreign.err).toContain(`names ${j.judge.address} as its judge, not ${stranger.address}`);

    h.engineLog = [announced(j.intent, j.worker.address, "cd".repeat(32), "other", 2n)];
    const nobody = await cli(judging(j, run, "--yes"), keys);
    expect(nobody.code).toBe(EXIT_FAILED);
    expect(nobody.err).toContain(`nobody announced the artifact with sha256 ${j.sha256} for intent ${j.intent}`);
    expect(existsSync(marker)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);

    const named = await cli(judging(j, "true", "--pay-to", j.copier.address, "--yes"), keys);
    expect(named.json()).toMatchObject({ verdict: "pass", payTo: j.copier.address, signature: expect.any(String) });
    expect(await paidTo(j, j.copier.address)).toBeGreaterThan(0n);
    const closed = await cli(judging(j, run), keys);
    expect(closed.err).toContain(`intent ${j.intent} is no longer open`);
    expect(existsSync(marker)).toBe(false);
  });

  it("takes a timeout within bounds and a non-empty command", async () => {
    expect(JUDGE_TIMEOUT).toBeLessThanOrEqual(MAX_JUDGE_TIMEOUT);
    for (const timeout of ["0", String(MAX_JUDGE_TIMEOUT + 1), "1.5"]) {
      expect((await cli(judging(j, "true", "--timeout", timeout), keys)).code).toBe(EXIT_USAGE);
    }
    expect(await cli(judging(j, " "), keys)).toMatchObject({ code: EXIT_USAGE, err: RUN_NEEDED });
  });

  it("lists the announced hashes of an escrow with their earliest announcer and how many copied them", async () => {
    expect((await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent], {})).json()).toEqual({
      intent: j.intent,
      deliveries: [{ sha256: j.sha256, worker: j.worker.address, url: WORK_URL, signature: "first", slot: "5", copies: 1 }],
    });
    expect((await cli(["deliveries", "--attestor", j.worker.address, "--intent", j.intent], {})).json()).toEqual({ intent: j.intent, deliveries: [] });
  });
});

describe("the artifact hash", () => {
  it("hashes a file as a one-entry manifest under its own name, and refuses links and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-"));
    await writeFile(join(dir, "work.tar"), "bytes");
    expect(await artifactSha256(join(dir, "work.tar"))).toBe(await manifestSha256([{ path: "work.tar", bytes: new TextEncoder().encode("bytes") }]));
    await mkdir(join(dir, "tree"));
    await writeFile(join(dir, "tree", "a"), "1");
    expect(await artifactSha256(join(dir, "tree"))).toBe(await manifestSha256([{ path: "a", bytes: new TextEncoder().encode("1") }]));
    await symlink(join(dir, "work.tar"), join(dir, "tree", "link"));
    await expect(artifactSha256(join(dir, "tree"))).rejects.toThrow("the artifact holds link, which is neither a regular file nor a directory");
    await expect(artifactSha256(join(dir, "missing"))).rejects.toThrow();
  });

  it("runs the command with the environment it is given and reports its exit code", async () => {
    expect(await runCheck('test "$ARTIFACT_SHA256" = given && exit 4', { ...process.env, ARTIFACT_SHA256: "given" }, TIMEOUT_SECONDS * 10)).toEqual({ exitCode: 4, timedOut: false });
    expect(await runCheck("sleep 600", process.env, TIMEOUT_SECONDS)).toEqual({ exitCode: null, timedOut: true });
  });
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const GUIDE = readFileSync(`${ROOT}/docs/judge.md`, "utf8");
const FENCE = "```";
const blocks = (language: string) =>
  GUIDE.split(`${FENCE}${language}\n`)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(`${FENCE}\n`)));
const guideLines = blocks("sh").flatMap((block) => block.trimEnd().split("\n"));

describe("the judge guide", () => {
  it("finds, checks and settles a proof escrow with exactly the commands it prints", async () => {
    const j = await job();
    const commands = guideLines.filter((l) => l.startsWith("intent-engine "));
    expect(guideLines.filter((l) => !l.startsWith("intent-engine "))).toEqual(['curl -fsSL -o spec.md "$SPEC_URL"', "chmod +x check.sh"]);
    expect(commands.map((c) => c.split(" ").slice(1, 2).join(" "))).toEqual(["jobs", "deliveries", "judge", "judge"]);
    expect(commands[3]).toBe(`${commands[2]} --yes`);
    const [script] = blocks("bash");
    const check = join(j.dir, "check.sh");
    await writeFile(check, script ?? "");
    await chmod(check, 0o755);
    h.watched.push(j.w.owner.address);
    h.env[ENV_KEYPAIR] = "judge.json";
    const files: Record<string, string> = { "spec.md": j.spec, work: j.artifact, "./check.sh": check, "verdict.json": join(j.dir, "verdict.json") };
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands) {
      const argv = line
        .replaceAll("$(solana address)", j.judge.address)
        .replaceAll("$INTENT", j.intent)
        .replaceAll("$OWNER", j.w.owner.address)
        .replaceAll("$NONCE", "0")
        .split(" ")
        .slice(1)
        .map((arg) => files[arg] ?? arg);
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];
    expect(outputs[0]).toMatchObject({ jobs: [{ intent: j.intent, owner: j.w.owner.address, nonce: "0", specUrl: null }] });
    expect(outputs[1]).toMatchObject({ deliveries: [{ sha256: j.sha256, worker: j.worker.address, copies: 1 }] });
    expect(outputs[2]).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: null });
    expect(outputs[3]).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    expect(GUIDE).toContain(`at most \`--timeout\` seconds (default ${JUDGE_TIMEOUT}, at most ${MAX_JUDGE_TIMEOUT})`);
    expect(GUIDE).toContain("skipping `.git`, `node_modules` and `target`");
    expect([...SKIPPED]).toEqual([".git", "node_modules", "target"]);
    expect(GUIDE).toContain(
      `gives it three environment variables: \`${ENV_SPEC_PATH}\`, the spec file; \`${ENV_ARTIFACT_PATH}\`, the work; \`${ENV_ARTIFACT_SHA256}\`, the work's hash.`,
    );
    expect(GUIDE).toContain(`records the memo \`${RELEASE_MEMO_PREFIX}<artifactSha256>\``);
    expect(GUIDE).toContain("Do steps 1 to 3 of the [quickstart](quickstart.md) first");
    expect(GUIDE).toContain("It does not sandbox it.");
  });
});
