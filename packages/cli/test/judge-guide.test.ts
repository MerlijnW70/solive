import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Address, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { ENV_KEYPAIR, ENV_URL, JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT } from "../src/args.js";
import { artifactSha256, ENV_ARTIFACT_PATH, ENV_ARTIFACT_SHA256, ENV_SPEC_PATH, SKIPPED } from "../src/judge.js";
import { EXIT_OK } from "../src/main.js";
import { SANDBOX_IMAGE } from "../src/sandbox.js";
import { announced as announce, keyed } from "./announce.js";
import { ata, balance, cli, funded, h, send, world } from "./harness.js";
import { boxed, job, paidTo, ROOT, SPEC, status, WORK_URL } from "./judge-kit.js";
import { DOCKER_TEST } from "./docker-switch.js";

const GUIDE = readFileSync(`${ROOT}/docs/judge.md`, "utf8") + "\n" + readFileSync(`${ROOT}/docs/maintainers/judge-internals.md`, "utf8");
const FENCE = "```";
const EXAMPLE_HEADING = "\n## Judge the word count example\n";
const STEPS = GUIDE.slice(0, GUIDE.indexOf(EXAMPLE_HEADING));
const EXAMPLE = GUIDE.slice(GUIDE.indexOf(EXAMPLE_HEADING), GUIDE.indexOf("\n## ", GUIDE.indexOf(EXAMPLE_HEADING) + 1));
const section = (heading: string) => GUIDE.slice(GUIDE.indexOf(`\n## ${heading}`), GUIDE.indexOf("\n## ", GUIDE.indexOf(`\n## ${heading}`) + 1));
const blocks = (language: string, text = STEPS) =>
  text
    .split(`${FENCE}${language}\n`)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(`${FENCE}\n`)));
const linesOf = (language: string, text = STEPS) => blocks(language, text).flatMap((block) => block.trimEnd().split("\n"));
const guideLines = linesOf("sh");
const words = (line: string, vars: Record<string, string>) =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/\$([A-Z]+)/g, (whole, name: string) => vars[name] ?? whole));
const WORD_COUNT = "examples/jobs/word-count";
const WORD_COUNT_FILE = `${WORD_COUNT}/delivery/wordcount.mjs`;
const JUDGE_LINE = /^export JUDGE=\$\(intent-engine balance \| (node -p .+)\)$/;
const HASH_LINE = /^export SPEC_HASH=\$\(intent-engine hash --artifact (\S+) \| (node -p .+)\)$/;
const POWERSHELL_HASH = (spec: string) => `$env:SPEC_HASH = (intent-engine hash --artifact ${spec} | Out-String | ConvertFrom-Json).sha256`;
const toPowerShell = (line: string) =>
  line.replace(/\$([A-Z_]+)\b/g, (whole, name: string) => (name === "PWD" ? whole : `$env:${name}`)).replace(/'\$PWD\/([^']+)'/g, (_, path: string) => `$PWD\\${path.replaceAll("/", "\\")}`);

async function specHashOf(line: string, root: string): Promise<string> {
  const [, spec = "", filter = ""] = HASH_LINE.exec(line) ?? [];
  const hashed = await cli(["hash", "--artifact", join(root, spec)], {});
  expect([hashed.code, hashed.err], line).toEqual([EXIT_OK, ""]);
  const picked = spawnSync("sh", ["-c", filter], { input: hashed.out, encoding: "utf8" });
  expect([picked.status, picked.stderr], filter).toEqual([0, ""]);
  return picked.stdout.trim();
}

function presetMint(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

describe("the judge guide", () => {
  it("finds, checks and settles a proof escrow with exactly the commands it prints", { ...DOCKER_TEST, timeout: 60_000 }, async () => {
    const j = await job();
    const commands = guideLines.filter((l) => l.startsWith("intent-engine "));
    const setup = guideLines.filter((l) => !l.startsWith("intent-engine "));
    expect(setup.slice(3)).toEqual(['curl -fsSL -o spec.md "$SPEC_URL"']);
    expect(setup[1]).toBe("export SPEC_URL=https://example.org/spec.md");
    expect(setup[2]).toMatch(HASH_LINE);
    h.env[ENV_KEYPAIR] = "judge.json";
    presetMint(NATIVE_MINT);
    const shown = await cli(["balance"], { "judge.json": j.judge });
    const picked = spawnSync("sh", ["-c", JUDGE_LINE.exec(setup[0] ?? "")?.[1] ?? "false"], { input: shown.out, encoding: "utf8" });
    expect([shown.err, picked.status, picked.stdout.trim()]).toEqual(["", 0, j.judge.address]);
    expect(commands.map((c) => c.split(" ").slice(1, 2).join(" "))).toEqual(["create", "jobs", "deliveries", "judge", "judge"]);
    expect(commands[4]).toBe(`${commands[3]} --yes`);
    const [node] = blocks("js");
    const [script] = blocks("bash");
    const check = join(j.dir, "check.mjs");
    await writeFile(check, node ?? "");
    const bashCheck = join(j.dir, "check.sh");
    await writeFile(bashCheck, script ?? "");
    h.watched.push(j.w.owner.address);
    h.env[ENV_KEYPAIR] = "judge.json";
    const vars = { PWD: j.dir, INTENT: j.intent, OWNER: j.w.owner.address, NONCE: "0", JUDGE: j.judge.address };
    const files: Record<string, string> = { "spec.md": j.spec, work: j.artifact, "verdict.json": join(j.dir, "verdict.json"), "check.mjs": check };
    const viaBash = await cli(boxed(j, "bash check/check.sh", "--check", bashCheck), { "judge.json": j.judge });
    expect(viaBash.json()).toMatchObject({ verdict: "pass", exitCode: 0, signature: null, sandbox: "docker", image: SANDBOX_IMAGE });
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands.slice(1)) {
      const argv = words(line, vars)
        .slice(1)
        .map((arg) => files[arg] ?? arg);
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];

    expect(GUIDE).toContain("pass `--check check.sh --run \"bash check/check.sh\"` in place of the `--check` and `--run` of step 5");
    expect(outputs[0]).toMatchObject({ jobs: [{ intent: j.intent, owner: j.w.owner.address, nonce: "0", specUrl: null }] });
    expect(outputs[1]).toMatchObject({ announcements: [{ worker: j.worker.address, commitment: j.first.commitment }, { worker: j.copier.address }] });
    expect(outputs[2]).toMatchObject({ verdict: "pass", command: "node check/check.mjs", sandbox: "docker", payTo: j.worker.address, signature: null });
    expect(outputs[3]).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    expect(GUIDE).toContain(`at most \`--timeout\` seconds (default ${JUDGE_TIMEOUT}, at most ${MAX_JUDGE_TIMEOUT})`);
    expect(GUIDE).toContain("skipping `.git`, `node_modules` and `target`");
    expect([...SKIPPED]).toEqual([".git", "node_modules", "target"]);
    expect(GUIDE).toContain(
      `gives it three environment variables: \`${ENV_SPEC_PATH}\`, the spec file; \`${ENV_ARTIFACT_PATH}\`, the work; \`${ENV_ARTIFACT_SHA256}\`, the work's hash.`,
    );
    expect(GUIDE).toContain("Do steps 1 and 2 of the [quickstart](quickstart.md) first.");
    expect(GUIDE).toContain(`by default \`${SANDBOX_IMAGE}\`, which holds Node.js 22`);
    expect(GUIDE).toContain("`--sandbox none` runs the check without a container");
    expect(GUIDE).not.toContain("sha256sum");
  });

  it("the judge guide creates the escrow it judges", { ...DOCKER_TEST, timeout: 60_000 }, async () => {
    const w = await world();
    const reader = await funded();
    const worker = await keyed();
    presetMint(NATIVE_MINT);
    presetMint(DEVNET_TEST_MINT);
    const wrapped = await findAssociatedTokenAddress({ owner: reader.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await send(reader, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: reader, owner: reader.address, mint: NATIVE_MINT }),
      getTransferSolInstruction({ source: reader, destination: wrapped, amount: 200_000_000n }),
      getSyncNativeInstruction({ account: wrapped }),
    ]);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    const dir = await mkdtemp(join(tmpdir(), "judge-guide-"));
    await writeFile(join(dir, "spec.md"), SPEC);
    const work = join(dir, "work");
    await mkdir(work);
    await writeFile(join(work, "answer.txt"), "42\n");
    await writeFile(join(dir, "check.mjs"), blocks("js")[0] ?? "");

    const created = section("1. Create a proof escrow");
    const [urlLine = "", hashLine = "", createLine = "", ...rest] = linesOf("sh", created);
    expect(rest).toEqual([]);
    const specUrl = /^export SPEC_URL=(https:\/\/\S+)$/.exec(urlLine)?.[1] ?? "";
    const specHash = await specHashOf(hashLine, dir);
    expect(specHash).toBe(createHash("sha256").update(SPEC).digest("hex"));
    expect(createLine.startsWith("intent-engine create attested ")).toBe(true);
    expect(createLine).toContain(" --attestor $JUDGE --spec-hash $SPEC_HASH --judge-fee 0.001 --spec-url $SPEC_URL ");
    expect(linesOf("powershell", created)).toEqual([`$env:SPEC_URL = "${specUrl}"`, POWERSHELL_HASH("spec.md"), toPowerShell(createLine)]);

    h.watched.push(reader.address);
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = "judge.json";
    const keys = { "judge.json": reader };
    const argv = createLine.replaceAll("$JUDGE", reader.address).replace("$SPEC_HASH", specHash).replace("$SPEC_URL", specUrl).split(" ").slice(1);
    const made = await cli(argv, keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    expect(balance(wrapped)).toBe(200_000_000n - 10_000_000n);

    const [jobsLine = ""] = linesOf("sh", section("2. Find the job")).filter((l) => l.startsWith("intent-engine jobs "));
    const listed = await cli(jobsLine.replace("$JUDGE", reader.address).split(" ").slice(1), keys);
    const [found] = (listed.json()["jobs"] ?? []) as { intent: Address; owner: string; nonce: string; specHash: string }[];
    expect(found).toMatchObject({ owner: reader.address, specHash });
    const intent = found?.intent ?? reader.address;
    const params = h.svm.getAccount(intent);
    expect(params.exists).toBe(true);

    const sha256 = await artifactSha256(work);
    await announce(intent, worker, sha256, WORK_URL);
    const vars = { PWD: dir, OWNER: found?.owner ?? "", NONCE: found?.nonce ?? "" };
    const judged = section("5. Judge and settle");
    const commands = linesOf("sh", judged);
    expect(commands).toHaveLength(2);
    expect(linesOf("powershell", judged)).toEqual(commands.map(toPowerShell));
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands) {
      const args = words(line, vars).slice(1).map((arg) => (["spec.md", "work", "verdict.json", "check.mjs"].includes(arg) ? join(dir, arg) : arg));
      const run = await cli(args, keys);
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];
    expect(outputs[0]).toMatchObject({ intent, specHash, artifactSha256: sha256, verdict: "pass", payTo: worker.address, signature: null });
    expect(outputs[1]).toMatchObject({ intent, verdict: "pass", payTo: worker.address, signature: expect.any(String) });
    const paid = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(paid)).toBeGreaterThan(0n);
    expect(status(intent)).toBe(IntentStatus.Filled);
  });

  it("the judge guide judges the word count example", { ...DOCKER_TEST, timeout: 60_000 }, async () => {
    const example = join(ROOT, WORD_COUNT);
    expect(GUIDE.indexOf(EXAMPLE_HEADING)).toBeGreaterThan(0);
    expect(EXAMPLE).toContain(`[\`${WORD_COUNT}\`](../${WORD_COUNT})`);
    const [tried = "", , settled = ""] = blocks("sh", EXAMPLE);
    const local = spawnSync(tried.trim(), { cwd: ROOT, shell: true, encoding: "utf8" });
    expect([local.status, local.stdout.trim()]).toEqual([0, "32 of 32 inputs hold"]);
    expect(EXAMPLE).toContain("prints `32 of 32 inputs hold`");
    const hashed = await cli(["hash", "--artifact", join(ROOT, WORD_COUNT_FILE)], {});
    const sha256 = String(hashed.json()["sha256"]);
    const j = await job(await readFile(join(example, "SPEC.md"), "utf8"), sha256);
    const commands = settled.trimEnd().split("\n");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(`${commands[0]} --yes`);
    h.watched.push(j.w.owner.address);
    h.env[ENV_KEYPAIR] = "judge.json";
    const vars = { PWD: resolve(ROOT), OWNER: j.w.owner.address, NONCE: "0" };
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands) {
      const [program, ...argv] = words(line, vars).map((arg) => (arg.startsWith("examples/") ? join(ROOT, arg) : arg === "verdict.json" ? join(j.dir, arg) : arg));
      expect(program).toBe("intent-engine");
      expect(argv[argv.indexOf("--run") + 1]).toBe("node check/check.mjs");
      expect(argv[argv.indexOf("--check") + 1]).toBe(join(example, "check.mjs"));
      expect(argv[argv.indexOf("--artifact") + 1]).toBe(join(ROOT, WORD_COUNT_FILE));
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];
    expect(outputs[0]).toMatchObject({ artifactSha256: sha256, exitCode: 0, verdict: "pass", payTo: j.worker.address, signature: null });
    expect(outputs[1]).toMatchObject({ artifactSha256: sha256, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
  });

  it("the word count section judges the file the spec names", async () => {
    const spec = await readFile(join(ROOT, WORD_COUNT, "SPEC.md"));
    expect(spec.toString("utf8")).toContain("Deliver one file, `wordcount.mjs`");
    const bytes = await readFile(join(ROOT, WORD_COUNT_FILE));
    const hashed = await cli(["hash", "--artifact", join(ROOT, WORD_COUNT_FILE)], {});
    expect(hashed.json()["sha256"]).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(EXAMPLE).toContain(`the plain sha256 of the file, the hash that \`intent-engine hash --artifact ${WORD_COUNT_FILE}\` prints`);
    expect(EXAMPLE).toContain(`commits the sha256 that \`intent-engine hash --artifact ${WORD_COUNT}/SPEC.md\` prints as its \`specHash\``);
    const [tried = "", values = "", settled = ""] = blocks("sh", EXAMPLE);
    expect(tried.trim()).toBe(`ARTIFACT_PATH=${WORD_COUNT_FILE} node ${WORD_COUNT}/check.mjs`);
    const [urlLine = "", hashLine = ""] = values.trimEnd().split("\n");
    expect(urlLine).toBe(["export SPEC_URL=https:", "", "raw.githubusercontent.com", "MerlijnW70", "solive", "main", WORD_COUNT, "SPEC.md"].join("/"));
    expect(await specHashOf(hashLine, ROOT)).toBe(createHash("sha256").update(spec).digest("hex"));
    const judgeLines = settled.trimEnd().split("\n");
    expect(judgeLines.every((line) => line.includes(` --artifact ${WORD_COUNT_FILE} `))).toBe(true);
    const [triedPs = "", valuesPs = "", settledPs = ""] = blocks("powershell", EXAMPLE).map((block) => block.trimEnd().split("\n"));
    expect(triedPs).toEqual([`$env:ARTIFACT_PATH = "${WORD_COUNT_FILE}"`, `node ${WORD_COUNT}/check.mjs`]);
    expect(valuesPs).toEqual([`$env:SPEC_URL = "${/^export SPEC_URL=(\S+)$/.exec(urlLine)?.[1] ?? ""}"`, POWERSHELL_HASH(`${WORD_COUNT}/SPEC.md`)]);
    expect(settledPs).toEqual(judgeLines.map(toPowerShell));
    expect(EXAMPLE).not.toContain(`--artifact ${WORD_COUNT}/delivery `);
    expect(EXAMPLE).not.toContain("sha256sum");
  });

  it("the judge guide lists every field deliveries prints", async () => {
    const j = await job();
    const printed = (await cli(["deliveries", "--intent", j.intent, "--judge-keypair", "judge.json"], { "judge.json": j.judge })).json();
    const fields = [...Object.keys(printed), ...Object.keys((printed["announcements"] as Record<string, unknown>[])[0] ?? {})];
    expect(fields.length).toBeGreaterThan(6);
    for (const field of fields) {
      expect(GUIDE).toContain(`\`${field}\``);
    }
  });
});
