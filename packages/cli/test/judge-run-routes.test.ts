import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { sortMembers, specMemo } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { checkFilesSha256, MAX_PINNED_TIMEOUT, RUN_OVERHEAD_SECONDS, TIMEOUT_RULE } from "../src/judge-run.js";
import { readArtifact } from "../src/artifact.js";
import { CHECK_UNPINNED, checkDiffers, checkNeeded, differs, GPU_REFUSED, NOT_DOCKER, timeoutShort, unpinned } from "../src/run-plan.js";
import { RUN_UNJUDGEABLE } from "../src/agent/wallet/seal.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { SANDBOX_IMAGE, SANDBOX_MEMORY } from "../src/sandbox.js";
import { strayFence } from "../src/spec-blocks.js";
import { announced, keyed } from "./announce.js";
import { cli, creation, funded, h, NOW, ownerSigned, transport, world } from "./harness.js";
import { boxed, job, type Job, status } from "./judge-kit.js";

const RUN = 'test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42';
const BLOCK = { image: SANDBOX_IMAGE, run: RUN, timeout: 20 };
const specWith = (fields: object | string) => `# Answer\n\nanswer.txt holds 42.\n\n\`\`\`judge-run\n${typeof fields === "string" ? fields : JSON.stringify(fields)}\n\`\`\`\n`;
const refused = (option: string, why: string) => `${option} ${why}; nothing was run or paid`;
const SKIP_FAKE = { skip: process.platform === "win32", timeout: 60_000 } as const;

const QUOTED_RUN = `# Answer\n\n> \`\`\`judge-run\n> ${JSON.stringify(BLOCK)}\n> \`\`\`\n`;
const LISTED_RUN = `# Answer\n\n- \`\`\`judge-run\n  ${JSON.stringify(BLOCK)}\n  \`\`\`\n`;
const QUOTED_CASES = '# Answer\n\n> ```judge-cases\n> {"cases": [{"args": [], "expected": 1}]}\n> ```\n';
const NESTED_RUN = `# Answer\n\n\`\`\`\`markdown\n\`\`\`judge-run\n${JSON.stringify(BLOCK)}\n\`\`\`\n\`\`\`\`\n`;
const AMBIGUOUS: [string, string][] = [
  [QUOTED_RUN, `the spec ${strayFence("judge-run", 1, 0)}`],
  [LISTED_RUN, `the spec ${strayFence("judge-run", 1, 0)}`],
  [NESTED_RUN, `the spec ${strayFence("judge-run", 1, 0)}`],
  [QUOTED_CASES, `the spec ${strayFence("judge-cases", 1, 0)}`],
];

async function noDocker<T>(body: (calls: () => Promise<string[]>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
  const log = join(dir, "calls.log");
  await writeFile(join(dir, "docker"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`);
  await chmod(join(dir, "docker"), 0o755);
  const saved = process.env["PATH"];
  process.env["PATH"] = [dir, saved ?? ""].join(delimiter);
  try {
    return await body(async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""));
  } finally {
    process.env["PATH"] = saved;
  }
}

async function checkFile(j: Job, name: string, text: string): Promise<{ path: string; sha256: string }> {
  const path = join(j.dir, name);
  await writeFile(path, text);
  return { path, sha256: await checkFilesSha256({ name, read: await readArtifact(path) }) };
}

const watching = (j: Job, run: string, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--run", run, "--watch", "--interval", "1", ...more];

describe("judge under a judge-run block refuses an unpinned check before anything runs", () => {
  it("refuses every option that differs from the block, with no Docker call, no verdict file and nothing paid", SKIP_FAKE, async () => {
    const check = "process.exit(0);\n";
    const probe = await job(specWith(BLOCK));
    const pinnedCheck = await checkFile(probe, "check.mjs", check);
    const table: [object, (j: Job, check: string) => string[], string][] = [
      [BLOCK, (j) => boxed(j, "true"), refused("--run", differs("true", RUN, "the run"))],
      [BLOCK, (j) => boxed(j, `${RUN} `), refused("--run", differs(`${RUN} `, RUN, "the run"))],
      [BLOCK, (j) => [...boxed(j, RUN), "--sandbox-image", `busybox@sha256:${"cd".repeat(32)}`], refused("--sandbox-image", differs(`busybox@sha256:${"cd".repeat(32)}`, SANDBOX_IMAGE, "the image"))],
      [{ ...BLOCK, memory: "256m" }, (j) => [...boxed(j, RUN), "--sandbox-memory", "2g"], refused("--sandbox-memory", differs("2g", "256m", "the memory"))],
      [{ ...BLOCK, cpus: "2" }, (j) => [...boxed(j, RUN), "--sandbox-cpus", "0.1"], refused("--sandbox-cpus", differs("0.1", "2", "the CPUs"))],
      [BLOCK, (j) => [...boxed(j, RUN), "--sandbox-gpu"], refused("--sandbox-gpu", GPU_REFUSED)],
      [BLOCK, (j) => [...boxed(j, RUN), "--sandbox", "none", "--i-trust-this-work"], refused("--sandbox none", NOT_DOCKER)],
      [BLOCK, (j) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper"], refused("--sandbox viper", NOT_DOCKER)],
      [BLOCK, (j) => [...boxed(j, RUN), "--timeout", String(20 + RUN_OVERHEAD_SECONDS - 1)], refused("--timeout", timeoutShort(20 + RUN_OVERHEAD_SECONDS - 1, 20))],
      [{ ...BLOCK, check_sha256: pinnedCheck.sha256 }, (j) => boxed(j, RUN), refused("--check", checkNeeded(pinnedCheck.sha256))],
      [BLOCK, (j, file) => [...boxed(j, RUN), "--check", file], refused("--check", CHECK_UNPINNED)],
    ];
    await noDocker(async (calls) => {
      for (const [fields, argv, why] of table) {
        const j = await job(specWith(fields));
        const { path } = await checkFile(j, "check.mjs", check);
        const verdict = join(j.dir, "verdict.json");
        const run = await cli([...argv(j, path), "--verdict", verdict, "--yes"], { "judge.json": j.judge });
        expect([run.code, run.out, run.err], why).toEqual([EXIT_FAILED, "", why]);
        expect(existsSync(verdict), why).toBe(false);
        expect(status(j.intent), why).toBe(IntentStatus.Open);
      }
      expect(await calls()).toEqual([]);
    });
  });

  it("refuses check files whose hash differs: other bytes, another name, or a directory around them", SKIP_FAKE, async () => {
    await noDocker(async (calls) => {
      const probe = await job();
      const pinned = await checkFile(probe, "check.mjs", "process.exit(0);\n");
      const j = await job(specWith({ ...BLOCK, check_sha256: pinned.sha256 }));
      const other = await checkFile(j, "check.mjs", "process.exit(1);\n");
      const renamed = await checkFile(j, "check2.mjs", "process.exit(0);\n");
      const dir = join(j.dir, "wrapped");
      await mkdir(dir);
      await writeFile(join(dir, "check.mjs"), "process.exit(0);\n");
      const wrapped = await checkFilesSha256({ name: "wrapped", read: await readArtifact(dir) });
      for (const [path, sha256] of [[other.path, other.sha256], [renamed.path, renamed.sha256], [dir, wrapped]] as const) {
        const run = await cli([...boxed(j, RUN), "--check", path], { "judge.json": j.judge });
        expect([run.code, run.err], path).toEqual([EXIT_FAILED, refused("--check", checkDiffers(path, sha256, `check_sha256 ${pinned.sha256}`))]);
      }
      expect(await calls()).toEqual([]);
    });
  });

  it("refuses a malformed block, at its boundary values, as the spec's fault before anything runs", SKIP_FAKE, async () => {
    await noDocker(async (calls) => {
      for (const [body, why] of [
        [{ ...BLOCK, timeout: 0 }, `the spec's judge-run block has timeout 0, which is not ${TIMEOUT_RULE}`],
        [{ ...BLOCK, timeout: MAX_PINNED_TIMEOUT + 1 }, `the spec's judge-run block has timeout ${MAX_PINNED_TIMEOUT + 1}, which is not ${TIMEOUT_RULE}`],
        [{ ...BLOCK, run: "" }, "the spec's judge-run block has run \"\", which is not"],
        [{ ...BLOCK, memory: "5m" }, 'the spec\'s judge-run block has memory "5m", which is not'],
        [{ ...BLOCK, user: "root" }, 'the spec\'s judge-run block has a field "user" it does not know'],
      ] as const) {
        const j = await job(specWith(body));
        const run = await cli(boxed(j, RUN), { "judge.json": j.judge });
        expect([run.code, run.err.startsWith(why), run.err.endsWith("; nothing was run or paid")], why).toEqual([EXIT_FAILED, true, true]);
      }
      expect(await calls()).toEqual([]);
    });
  });

  it("refuses a quoted, listed or nested fence of either kind, which a Markdown reader may see as the check, on every sandbox", SKIP_FAKE, async () => {
    await noDocker(async (calls) => {
      for (const [text, why] of AMBIGUOUS) {
        for (const argv of [(j: Job) => boxed(j, RUN), (j: Job) => [...boxed(j, RUN), "--sandbox", "none", "--i-trust-this-work"], (j: Job) => boxed(j, RUN).filter((part, i, all) => part !== "--run" && all[i - 1] !== "--run").concat(["--sandbox", "viper"])]) {
          const j = await job(text);
          const run = await cli(argv(j), { "judge.json": j.judge });
          expect([run.code, run.out, run.err], `${why} ${argv(j).slice(-2).join(" ")}`).toEqual([EXIT_FAILED, "", `${why}; nothing was run or paid`]);
          expect(status(j.intent)).toBe(IntentStatus.Open);
        }
      }
      expect(await calls()).toEqual([]);
    });
  });

  it("signs the verdict with the pinned image and command, not the judge's defaults", SKIP_FAKE, async () => {
    const image = `busybox@sha256:${"cd".repeat(32)}`;
    const dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
    const log = join(dir, "calls.log");
    const state = '{"Running":false,"ExitCode":0,"OOMKilled":false,"Error":"","StartedAt":"2026-01-01T00:00:00Z","FinishedAt":"2026-01-01T00:00:01Z"}';
    await writeFile(
      join(dir, "docker"),
      `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in\n  version) echo 27.0.0 ;;\n  container) if [ "$3" = "--format" ]; then echo '${state}'; exit 0; fi; exit 1 ;;\nesac\nexit 0\n`,
    );
    await chmod(join(dir, "docker"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = [dir, saved ?? ""].join(delimiter);
    try {
      const j = await job(specWith({ ...BLOCK, image, memory: "64m" }));
      const run = await cli(boxed(j, RUN), { "judge.json": j.judge });
      expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
      expect(run.json()).toMatchObject({ verdict: "pass", image, command: RUN, judgeRun: { image, run: RUN, memory: "64m" } });
      const calls = (await readFile(log, "utf8")).split("\n");
      expect(calls.filter((line) => line.startsWith("image inspect"))).toEqual([`image inspect --format {{.Id}} ${image}`]);
      const started = calls.find((line) => line.startsWith("run ")) ?? "";
      expect(started).toContain(`--memory 64m --memory-swap 64m`);
      expect(started).toContain(` ${image} -c ${RUN}`);
      expect(started).not.toContain(SANDBOX_IMAGE);
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("refuses the same way before judge --watch fetches or judges any delivery", SKIP_FAKE, async () => {
    await noDocker(async (calls) => {
      const probe = await job();
      const pinned = await checkFile(probe, "check.mjs", "process.exit(0);\n");
      const j = await job(specWith({ ...BLOCK, check_sha256: pinned.sha256 }));
      const other = await checkFile(j, "check.mjs", "process.exit(1);\n");
      for (const [argv, why] of [
        [watching(j, "true"), refused("--run", differs("true", RUN, "the run"))],
        [[...watching(j, RUN), "--sandbox-memory", "2g"], refused("--sandbox-memory", unpinned("2g", SANDBOX_MEMORY, "memory"))],
        [watching(j, RUN), refused("--check", checkNeeded(pinned.sha256))],
        [[...watching(j, RUN), "--check", other.path], refused("--check", checkDiffers(other.path, other.sha256, `check_sha256 ${pinned.sha256}`))],
      ] as const) {
        const run = await cli([...argv], { "judge.json": j.judge });
        expect([run.code, run.out, run.err], why).toEqual([EXIT_FAILED, "", why]);
      }
      expect(await calls()).toEqual([]);
      expect(status(j.intent)).toBe(IntentStatus.Open);
    });
  });

  it("refuses the same way for a committee member, who then gives no vote", SKIP_FAKE, async () => {
    await noDocker(async (calls) => {
      const w = await world();
      const members = await Promise.all([0, 1, 2].map(() => funded()));
      const payer = await funded();
      const keys: Record<string, KeyPairSigner> = { "payer.json": payer };
      members.forEach((member, i) => (keys[`m${i}.json`] = member));
      const created = await cli(
        ["committee", "create", "--keypair", "payer.json", "--members", sortMembers(members.map((m) => m.address)).join(","), "--threshold", "2", "--fee-wallet", (await generateKeyPairSigner()).address, "--yes"],
        keys,
      );
      expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
      const committee = created.json()["committee"] as Address;
      const dir = await mkdtemp(join(tmpdir(), "committee-run-"));
      const spec = join(dir, "spec.md");
      const text = specWith(BLOCK);
      await writeFile(spec, text);
      const artifact = join(dir, "answer.txt");
      await writeFile(artifact, "42\n");
      const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(createHash("sha256").update(text).digest()), judgeFee: 0n } as const;
      const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
      await announced(intent, await keyed(), createHash("sha256").update("42\n").digest("hex"), "https://" + "example.org/answer.txt");
      const verdict = join(dir, "vote.json");
      const member = (...more: string[]) => ["judge", "--keypair", "m0.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--verdict", verdict, ...more];
      for (const [argv, why] of [
        [member("--run", "true"), refused("--run", differs("true", RUN, "the run"))],
        [member("--run", RUN, "--sandbox-image", `busybox@sha256:${"cd".repeat(32)}`), refused("--sandbox-image", differs(`busybox@sha256:${"cd".repeat(32)}`, SANDBOX_IMAGE, "the image"))],
        [member("--sandbox", "viper"), refused("--sandbox viper", NOT_DOCKER)],
      ] as const) {
        const run = await cli([...argv], keys);
        expect([run.code, run.out, run.err], why).toEqual([EXIT_FAILED, "", why]);
        expect(existsSync(verdict)).toBe(false);
      }
      expect(await calls()).toEqual([]);
    });
  });
});

describe("the hirer's and worker's CLI see the pinned check", () => {
  it("spec shows the block as judge_run, a malformed one as judge_run_refused, and a spec without one as before", async () => {
    const w = await world();
    const owner = await funded();
    const shown = async (text: string, nonce: bigint) => {
      const url = "https://" + `specs.example.org/${nonce}.md`;
      h.specPages.set(url, new TextEncoder().encode(text));
      const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: owner.address, specHash: new Uint8Array(createHash("sha256").update(text).digest()), judgeFee: 0n } as const;
      const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce, expiresAt: NOW + 3_600n });
      h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(url)]) });
      const read = await cli(["spec", "--intent", intent], {});
      expect([read.code, read.err]).toEqual([EXIT_OK, ""]);
      return read.json();
    };
    expect(await shown(specWith({ ...BLOCK, memory: "512m", check_sha256: "ab".repeat(32) }), 0n)).toMatchObject({
      matches: true,
      judge_run: { image: SANDBOX_IMAGE, run: RUN, timeout: 20, memory: "512m", cpus: null, check_files_pinned: true, check_sha256: "ab".repeat(32) },
    });
    expect((await shown(specWith({ ...BLOCK, timeout: 0 }), 1n))["judge_run_refused"]).toBe(`the spec's judge-run block has timeout 0, which is not ${TIMEOUT_RULE}`);
    const plain = await shown("# Answer\n\nanswer.txt holds 42.\n", 2n);
    expect(Object.keys(plain).sort()).toEqual(["matches", "sha256", "text", "url"]);
  });

  it("spec and the create attested preflight refuse a quoted, listed or nested fence of either kind", async () => {
    const w = await world();
    const owner = await funded();
    for (const [n, [text, why]] of AMBIGUOUS.entries()) {
      const url = "https://" + `specs.example.org/odd-${n}.md`;
      h.specPages.set(url, new TextEncoder().encode(text));
      const specHash = createHash("sha256").update(text).digest("hex");
      const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: owner.address, specHash: new Uint8Array(Buffer.from(specHash, "hex")), judgeFee: 0n } as const;
      const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: BigInt(n), expiresAt: NOW + 3_600n });
      h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(url)]) });
      const read = await cli(["spec", "--intent", intent], {});
      expect(read.json()["judge_run_refused"], why).toBe(why);
      expect(read.json(), why).not.toHaveProperty("judge_run");
      const created = await cli(
        ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.0001", "--min-result", "1", "--max-result", "1", "--attestor", owner.address, "--spec-hash", specHash, "--spec-url", url, "--yes"],
        { "owner.json": w.owner },
      );
      expect(created.code, why).not.toBe(EXIT_OK);
      expect(created.err, why).toContain(`--spec-url ${url}: ${why}; ${RUN_UNJUDGEABLE}`);
    }
  });

  it("seal and create attested refuse a malformed block before anything is written or sent", async () => {
    const w = await world();
    const judge = await keyed("judge.json");
    const dir = await mkdtemp(join(tmpdir(), "seal-run-"));
    const plain = join(dir, "spec.md");
    const bad = specWith({ ...BLOCK, image: "node:22" });
    await writeFile(plain, bad);
    const out = join(dir, "spec.sealed");
    const sealed = await cli(["seal", "--file", plain, "--to", judge.address, "--out", out], {});
    expect(sealed.code).toBe(EXIT_FAILED);
    expect(sealed.err).toContain(`${plain}: the spec's judge-run block has image "node:22"`);
    expect(existsSync(out)).toBe(false);
    await writeFile(plain, specWith(BLOCK));
    expect((await cli(["seal", "--file", plain, "--to", judge.address, "--out", out], {})).code).toBe(EXIT_OK);
    h.files.set("spec.md", bad);
    const before = h.wires.length;
    const create = await cli(
      ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.0001", "--min-result", "1", "--max-result", "1", "--attestor", judge.address, "--spec-hash", createHash("sha256").update(bad).digest("hex"), "--spec-file", "spec.md", "--yes"],
      { "owner.json": w.owner },
    );
    expect([create.code === EXIT_FAILED || create.code === EXIT_USAGE, create.err]).toEqual([true, `--spec-file spec.md: the spec's judge-run block has image "node:22", which is not an image named by its digest, <name>@sha256:<64 lowercase hex>; ${RUN_UNJUDGEABLE}`]);
    const url = "https://" + "specs.example.org/bad.md";
    h.specPages.set(url, new TextEncoder().encode(bad));
    const fromUrl = await cli(
      ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.0001", "--min-result", "1", "--max-result", "1", "--attestor", judge.address, "--spec-hash", createHash("sha256").update(bad).digest("hex"), "--spec-url", url],
      { "owner.json": w.owner },
    );
    expect(fromUrl.code).not.toBe(EXIT_OK);
    expect(fromUrl.err).toContain(`--spec-url ${url}: the spec's judge-run block has image "node:22"`);
    expect(h.wires.length).toBe(before);
  });
});
