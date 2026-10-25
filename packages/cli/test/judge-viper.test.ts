import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { ENV_KEYPAIR } from "../src/args.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { sandboxOnly, VIPER_TAKES_NO_RUN } from "../src/sandbox.js";
import { casesMissing, DEFAULT_HEAP, DEFAULT_STEPS, VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../src/viper.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, funded, h, NOW, transport, type World, world } from "./harness.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one"], "expected": 1}, {"args": ["one\\ttwo\\u3000three"], "expected": 3}]}';
const SPEC = `# Count words\n\nCount whitespace-separated words.\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.split(' ').length; }\n";

type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; dir: string; spec: string; artifact: string; sha256: string; announcement: Address; salt: string };

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

async function job(module: string, specText = SPEC): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "judge-viper-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  const artifact = join(dir, "count.mjs");
  await writeFile(artifact, module);
  const sha256 = sha(module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(specText).digest()), judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const made = await announced(intent, worker, sha256, "https://" + "example.org/count.mjs");
  return { w, judge, worker, intent, dir, spec, artifact, sha256, announcement: made.announcement, salt: made.salt };
}

const judging = (j: Job, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper", ...more];

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const paidTo = async (j: Job) => balance(await findAssociatedTokenAddress({ owner: j.worker.address, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

describe("intent-engine judge --sandbox viper", () => {
  let keys: Record<string, KeyPairSigner>;

  beforeEach(() => {
    keys = {};
  });

  it("judges the spec's cases in the pinned module, records which, and pays only on a pass", async () => {
    const j = await job(CORRECT);
    keys = { "judge.json": j.judge };
    const verdict = join(j.dir, "verdict.json");
    const preview = await cli(judging(j, "--verdict", verdict), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const shown = {
      intent: j.intent,
      specHash: sha(SPEC),
      artifactSha256: j.sha256,
      command: "viper",
      sandbox: "viper",
      engine: { wasmSha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT },
      cases: { total: 3, passed: 3, failures: [], seed: expect.any(Number), clock: expect.any(Number) },
      host: { engine: "node-vm", total: 3, passed: 3, failures: [] },
      exitCode: null,
      verdict: "pass",
      payTo: j.worker.address,
      announcement: j.announcement,
      seq: "1",
      salt: j.salt,
      signature: null,
    };
    expect(preview.json()).toEqual({ ...shown, simulated: { ok: true, units_consumed: expect.any(Number) }, next: NOT_SENT });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(preview.json());
    const sent = await cli(judging(j, "--yes"), keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toEqual({ ...shown, signature: expect.any(String) });
    expect(await paidTo(j)).toBeGreaterThan(0n);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });

  it("fails a wrong delivery, names its cases and sends nothing", async () => {
    const j = await job(WRONG);
    keys = { "judge.json": j.judge };
    const failed = await cli(judging(j, "--yes"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({
      verdict: "fail",
      signature: null,
      cases: { total: 3, passed: 1, failures: [{ case: 0, verdict: "wrong", detail: 1 }, { case: 2, verdict: "wrong", detail: 1 }] },
    });
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("fails a delivery that tampers, loops or reaches for the host, and sends nothing", async () => {
    for (const [module, verdict] of [
      ["JSON.stringify = () => '0'; Object.is = () => true; export default () => 42;", "wrong"],
      ["export default () => ({ valueOf() { return 0; } });", "not-primitive"],
      ["export default () => { for (;;) {} };", "stopped"],
      ["import fs from 'node:fs'; export default () => 0;", "no-module"],
    ] as const) {
      const j = await job(module);
      keys = { "judge.json": j.judge };
      const failed = await cli(judging(j, "--yes"), keys);
      expect(failed.code, module).toBe(EXIT_FAILED);
      const cases = failed.json()["cases"] as { passed: number; failures: { case: number; verdict: string }[] };
      expect(cases.passed, module).toBe(0);
      expect(cases.failures[0], module).toMatchObject({ case: 0, verdict });
      expect(status(j.intent), module).toBe(IntentStatus.Open);
    }
  }, 60_000);

  it("fails a delivery that is right only where it cannot see Intl, as inside the sandbox, and pays nothing", async () => {
    const sniffing = "export default function count(text) { if (typeof Intl !== 'undefined') return -1; const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
    const j = await job(sniffing);
    keys = { "judge.json": j.judge };
    const judged = await cli(judging(j, "--yes"), keys);
    expect(judged.code).toBe(EXIT_FAILED);
    expect(judged.json()).toMatchObject({
      verdict: "fail",
      signature: null,
      cases: { total: 3, passed: 3 },
      host: { engine: "node-vm", total: 3, passed: 0 },
    });
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("refuses before judging when the spec has no cases or the artifact is a directory", async () => {
    const j = await job(CORRECT, "# no cases\n");
    keys = { "judge.json": j.judge };
    const bare = await cli(judging(j, "--yes"), keys);
    expect(bare.code).toBe(EXIT_FAILED);
    expect(bare.err).toContain(casesMissing(0));
    const k = await job(CORRECT);
    keys = { "judge.json": k.judge };
    const folder = join(k.dir, "folder");
    await mkdir(folder);
    await writeFile(join(folder, "count.mjs"), CORRECT);
    const directory = await cli([...judging(k, "--yes").map((arg) => (arg === k.artifact ? folder : arg))], keys);
    expect(directory.code).toBe(EXIT_FAILED);
    expect(directory.err).toContain("is a directory");
    expect(status(k.intent)).toBe(IntentStatus.Open);
  });

  it("takes no command, no check and no container options", async () => {
    const j = await job(CORRECT);
    for (const [more, said] of [
      [["--run", "true"], VIPER_TAKES_NO_RUN],
      [["--check", "check.mjs"], VIPER_TAKES_NO_RUN],
      [["--sandbox-memory", "512m"], sandboxOnly("sandbox-memory")],
    ] as const) {
      const refused = await cli(judging(j, ...more), keys);
      expect(refused.code).toBe(EXIT_USAGE);
      expect(refused.err).toContain(said);
    }
  });
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const GUIDE = readFileSync(join(ROOT, "docs/judge.md"), "utf8") + "\n" + readFileSync(join(ROOT, "docs/maintainers/judge-internals.md"), "utf8");
const SECTION = GUIDE.slice(GUIDE.indexOf("## Judge without Docker"), GUIDE.indexOf("## Who is paid"));
const FENCE = "```";
const block = (language: string) => SECTION.split(`${FENCE}${language}\n`)[1]?.split(`${FENCE}\n`)[0]?.trimEnd().split("\n") ?? [];

describe("the judge guide without Docker", () => {
  it("judges the word count example with exactly the commands it prints", async () => {
    const example = join(ROOT, "examples/jobs/word-count");
    const specText = await readFile(join(example, "SPEC.md"), "utf8");
    const j = await job(await readFile(join(example, "delivery/wordcount.mjs"), "utf8"), specText);
    const commands = block("sh");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(`${commands[0]} --yes`);
    expect(block("powershell")).toEqual(commands.map((line) => line.replace(/\$([A-Z]+)/g, "$env:$1")));
    h.env[ENV_KEYPAIR] = "judge.json";
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands) {
      const [program, ...argv] = line
        .replace(/\$OWNER/g, j.w.owner.address)
        .replace(/\$NONCE/g, "0")
        .split(" ")
        .map((arg) => (arg.startsWith("examples/") ? join(ROOT, arg) : arg === "verdict.json" ? join(j.dir, arg) : arg));
      expect(program).toBe("intent-engine");
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];
    expect(outputs[0]).toMatchObject({ sandbox: "viper", cases: { total: 18, passed: 18, failures: [] }, verdict: "pass", signature: null });
    expect(outputs[1]).toMatchObject({ sandbox: "viper", verdict: "pass", signature: expect.any(String) });
    expect(await paidTo(j)).toBeGreaterThan(0n);
  });

  it("states the defaults the judge uses", () => {
    expect(GUIDE).toContain(`\`steps\` (default ${DEFAULT_STEPS})`);
    expect(GUIDE).toContain(`\`heap\` in bytes (default ${DEFAULT_HEAP})`);
  });
});
