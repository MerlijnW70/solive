import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind } from "@intent-engine/core";
import { createClient, type EngineTransaction } from "@intent-engine/client";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { HOST_ENGINE, judgeHost, nodeSeed } from "../src/host-judge.js";
import { judgeNode, NODE_ENGINE } from "../src/node-judge.js";
import { CPUS_FORMAT, IMAGE_NEEDS_DIGEST, MEMORY_FORMAT, PLAIN_NODE_ONLY, SANDBOX_CPUS, SANDBOX_IMAGE, SANDBOX_MEMORY, sandboxOnly, VIPER_TAKES_NO_RUN } from "../src/sandbox.js";
import { type Cases, casesOf as publishedCases, judgeViper, pinnedWasm } from "../src/viper.js";
import { DOCKER_TEST } from "./docker-switch.js";
import { sealedDelivery } from "./announce.js";
import { balance, cli, creation, funded, h, NOW, transport, type World, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLE = join(ROOT, "examples/jobs/word-count");
const WORD_SPEC = readFileSync(join(EXAMPLE, "SPEC.md"), "utf8");
const WORD_COUNT = readFileSync(join(EXAMPLE, "delivery/wordcount.mjs"), "utf8");
const WORD_CASES = 18;
const HUNTED =
  "export default function count(text) {\n  const words = text.match(/\\S+/g);\n  const counted = words === null ? 0 : words.length;\n  return import.meta.url === undefined ? counted : counted + 1;\n}\n";
const specOf = (cases: string) => `# Job\n\n\`\`\`judge-cases\n${cases}\n\`\`\`\n`;
const BOX = { image: SANDBOX_IMAGE, memory: SANDBOX_MEMORY, cpus: SANDBOX_CPUS };

type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; dir: string; spec: string; artifact: string };

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

async function job(module: string, specText: string, name = "wordcount.mjs"): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await generateKeyPairSigner();
  const dir = await mkdtemp(join(tmpdir(), "judge-node-test-"));
  const spec = join(dir, "SPEC.md");
  await writeFile(spec, specText);
  const artifact = join(dir, name);
  await writeFile(artifact, module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(specText).digest()), judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const delivered: EngineTransaction = {
    signature: "first",
    slot: 5n,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: [await sealedDelivery(intent, worker.address, sha(module), "https://example.org/" + name, [judge.address])],
    feePayer: worker.address,
  };
  h.engineLog = [delivered, creation(intent)];
  return { w, judge, worker, intent, dir, spec, artifact };
}

const judging = (j: Job, ...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--sandbox", "viper", ...more];

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const paidTo = async (j: Job) => balance(await findAssociatedTokenAddress({ owner: j.worker.address, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const casesOf = (list: Cases["cases"], seed = 1): Cases => ({ steps: 1_000_000, heap: 1 << 24, seed, clock: 0, cases: list });
const bytes = (source: string) => new TextEncoder().encode(source);

type Engine = { total: number; passed: number; failures: { case: number; verdict: string; detail?: unknown }[] };

describe("judge --sandbox viper --plain-node", () => {
  it("J-3: a module that answers wrongly once import.meta.url is defined passes viper and host but fails judge --plain-node and pays nothing", DOCKER_TEST, async () => {
    const j = await job(HUNTED, WORD_SPEC);
    const keys = { "judge.json": j.judge };
    const twoEngines = await cli(judging(j), keys);
    expect([twoEngines.code, twoEngines.err]).toEqual([EXIT_OK, ""]);
    expect(twoEngines.json()).toMatchObject({ verdict: "pass", cases: { total: WORD_CASES, passed: WORD_CASES }, host: { total: WORD_CASES, passed: WORD_CASES } });
    expect(twoEngines.json()).not.toHaveProperty("node");
    const plain = await cli(judging(j, "--plain-node", "--yes"), keys);
    expect(plain.code).toBe(EXIT_FAILED);
    const verdict = plain.json();
    expect(verdict).toMatchObject({
      verdict: "fail",
      signature: null,
      cases: { total: WORD_CASES, passed: WORD_CASES },
      host: { engine: HOST_ENGINE, total: WORD_CASES, passed: WORD_CASES },
      node: { engine: NODE_ENGINE, image: SANDBOX_IMAGE, total: WORD_CASES, passed: 0 },
    });
    const failures = (verdict["node"] as Engine).failures;
    expect(failures.every((failure) => failure.verdict === "wrong")).toBe(true);
    expect(failures[0]).toEqual({ case: 0, verdict: "wrong", detail: 1 });
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect(await paidTo(j)).toBeLessThanOrEqual(0n);
  });

  it("judge --plain-node passes the word count delivery in all three engines and records the image and the module path", DOCKER_TEST, async () => {
    const j = await job(WORD_COUNT, WORD_SPEC);
    const keys = { "judge.json": j.judge };
    const verdictFile = join(j.dir, "verdict.json");
    const preview = await cli(judging(j, "--plain-node", "--verdict", verdictFile), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const node = { engine: NODE_ENGINE, image: SANDBOX_IMAGE, path: expect.stringMatching(/^\/judge\/[0-9a-f]{32}\/wordcount\.mjs$/), total: WORD_CASES, passed: WORD_CASES, failures: [] };
    expect(preview.json()).toMatchObject({
      sandbox: "viper",
      verdict: "pass",
      signature: null,
      cases: { total: WORD_CASES, passed: WORD_CASES, failures: [] },
      host: { engine: HOST_ENGINE, total: WORD_CASES, passed: WORD_CASES, failures: [] },
      node,
    });
    expect(preview.json()).not.toHaveProperty("image");
    expect(JSON.parse(await readFile(verdictFile, "utf8"))).toEqual(preview.json());
    const paid = await cli(judging(j, "--plain-node", "--yes"), keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", node, signature: expect.any(String), payTo: j.worker.address });
    expect((paid.json()["node"] as { path: string }).path).not.toBe((preview.json()["node"] as { path: string }).path);
    expect(await paidTo(j)).toBeGreaterThan(0n);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });

  it("a delivery that forges output, exits early or patches built-ins in plain Node passes no case it answers wrongly", DOCKER_TEST, async () => {
    const cases = casesOf([
      { args: ["one"], expected: 1 },
      { args: ["one two"], expected: 2 },
    ]);
    const forged = '["answer","number","1"]';
    const wrong = [
      `process.stdout.write(${JSON.stringify(`${forged}\n{"token":"","out":"","code":0,"timedOut":false,"over":false}\npass\n`)}); console.error("pass"); export default () => -1;`,
      `export default () => { process.stdout.write(${JSON.stringify(forged)}); setTimeout(() => process.stdout.write(${JSON.stringify(forged)}), 1); return -1; };`,
      "process.exit(0); export default () => -1;",
      `export default () => { process.stdout.write(${JSON.stringify(forged)}); process.exit(0); };`,
      "export default () => { process.exitCode = 0; throw new Error('pass'); };",
      [
        "import { createRequire, syncBuiltinESMExports } from 'node:module';",
        "const fs = createRequire(import.meta.url)('node:fs');",
        `const fake = Buffer.from(${JSON.stringify(forged)});`,
        "fs.writeSync = (fd) => process.stdout.write(fake);",
        "syncBuiltinESMExports();",
        `JSON.stringify = () => ${JSON.stringify(forged)};`,
        "Reflect.apply = () => 1;",
        "Buffer.from = () => fake;",
        "String.prototype.split = () => ['', '[\"answer\",\"number\",\"1\"]', ''];",
        "Object.defineProperty(Object.prototype, 'toJSON', { get() { return () => 1; } });",
        "Number.prototype.toString = () => '1';",
        "process.exit = () => undefined;",
        "export default () => -1;",
      ].join("\n"),
      [
        "import { readdirSync, readFileSync } from 'node:fs';",
        "const runner = readdirSync('/judge/runner').map((name) => readFileSync('/judge/runner/' + name, 'utf8')).join('');",
        "let launcher = '';",
        "try { launcher = readFileSync('/proc/1/cmdline', 'utf8'); } catch {}",
        "process.stdout.write(runner + launcher);",
        "export default () => -1;",
      ].join("\n"),
      "export default () => ({ valueOf() { return 1; }, toString() { return '1'; } });",
      "export default async () => 1;",
    ];
    for (const module of wrong) {
      const { judged } = await judgeNode(BOX, bytes(module), "count.mjs", cases, 7, 60);
      expect(judged.passed, module).toBe(0);
      expect(judged.failures.map((failure) => failure.verdict).includes("pass" as never), module).toBe(false);
    }
    const noisy = "process.stdout.write('[\"answer\",\"number\",\"9\"]'); console.error('noise'); export default (text) => { const n = text.split(' ').length; JSON.stringify = () => '9'; return n; };";
    const { judged } = await judgeNode(BOX, bytes(noisy), "count.mjs", cases, 7, 60);
    expect(judged).toMatchObject({ engine: NODE_ENGINE, total: 2, passed: 2, failures: [] });
  });

  it("the plain Node engine gives the delivery no network and no writable files", DOCKER_TEST, async () => {
    const probe = [
      "import fs from 'node:fs';",
      "import net from 'node:net';",
      "import os from 'node:os';",
      "import dns from 'node:dns/promises';",
      "const writable = [];",
      "const walk = (dir) => {",
      "  let entries;",
      "  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }",
      "  try { fs.accessSync(dir, fs.constants.W_OK); writable.push(dir); } catch {}",
      "  for (const entry of entries) {",
      "    const path = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;",
      "    if (entry.isDirectory() && path !== '/proc' && path !== '/sys') walk(path);",
      "  }",
      "};",
      "walk('/');",
      "for (const dir of [process.cwd(), os.tmpdir(), os.homedir(), '/tmp', '/dev/shm', '/judge', '/var/tmp', '/']) {",
      "  try { fs.writeFileSync(dir + '/probe', 'x'); writable.push(dir + '/probe'); } catch {}",
      "}",
      "const reached = await new Promise((done) => {",
      "  const socket = net.connect(53, '1.1.1.1');",
      "  socket.on('connect', () => done('connected'));",
      "  socket.on('error', () => done('no route'));",
      "  setTimeout(() => done('no answer'), 2000).unref();",
      "});",
      "let named = 'unresolved';",
      "try { await dns.lookup('example.org'); named = 'resolved'; } catch {}",
      "let fetched = 'failed';",
      "try { await fetch('https://' + 'example.org'); fetched = 'fetched'; } catch {}",
      "const report = JSON.stringify({ writable, interfaces: Object.keys(os.networkInterfaces()), reached, named, fetched });",
      "export default () => report;",
    ].join("\n");
    const expected = JSON.stringify({ writable: [], interfaces: ["lo"], reached: "no route", named: "unresolved", fetched: "failed" });
    const { judged } = await judgeNode(BOX, bytes(probe), "probe.mjs", casesOf([{ args: [], expected }]), 7, 60);
    expect(judged.failures).toEqual([]);
    expect(judged).toMatchObject({ engine: NODE_ENGINE, total: 1, passed: 1 });
  });

  it("the host and plain Node engines draw the same Math.random values from the verdict's seed", DOCKER_TEST, async () => {
    const drawing = "export default () => [Math.random(), Math.random(), Math.random()].join(',');\n";
    const j = await job(drawing, specOf('{"cases": [{"args": [], "expected": "never"}]}'), "draw.mjs");
    const keys = { "judge.json": j.judge };
    const drawn: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const judged = await cli(judging(j, "--plain-node"), keys);
      expect(judged.code).toBe(EXIT_FAILED);
      const verdict = judged.json() as { cases: { seed: number }; host: Engine; node: Engine };
      const fromHost = verdict.host.failures[0]?.detail;
      expect(typeof fromHost).toBe("string");
      expect(verdict.node.failures[0]?.detail).toBe(fromHost);
      const rerun = execFileSync(process.execPath, [`--random-seed=${nodeSeed(verdict.cases.seed)}`, "--input-type=module", "-e", `process.stdout.write((await import(${JSON.stringify(pathToFileURL(j.artifact).href)})).default())`], { encoding: "utf8" });
      expect(rerun).toBe(fromHost);
      drawn.push(String(fromHost));
    }
    expect(drawn[0]).not.toBe(drawn[1]);
    const pinned = await judgeHost(bytes(drawing), casesOf([{ args: [], expected: "never" }], 99), 20, 99);
    const again = await judgeNode(BOX, bytes(drawing), "draw.mjs", casesOf([{ args: [], expected: "never" }], 99), 99, 60);
    expect(again.judged.failures[0]?.detail).toBe(pinned.failures[0]?.detail);
    expect(nodeSeed(0)).toBe(1);
    expect(nodeSeed(2 ** 48)).toBeGreaterThan(0);
    expect(nodeSeed(2 ** 48)).toBeLessThan(2 ** 31);
  });

  it("every engine hands a delivery each published argument exactly as the spec writes it, -0 included", DOCKER_TEST, async () => {
    const telling = "export default (...args) => args.map((arg) => (Object.is(arg, -0) ? 'minus zero' : typeof arg + ':' + String(arg))).join('|');\n";
    const listed: [Cases["cases"][number]["args"], string][] = [
      [[-0], "minus zero"],
      [[0, -0, 0], "number:0|minus zero|number:0"],
      [[-1.5, 2, 1e21, -0, 5e-324], "number:-1.5|number:2|number:1e+21|minus zero|number:5e-324"],
      [["-0", "", "a\"b\\c", "\u2028"], "string:-0|string:|string:a\"b\\c|string:\u2028"],
      [[true, false, null, -0], "boolean:true|boolean:false|object:null|minus zero"],
      [[], ""],
    ];
    const text = `{"cases": [${listed.map(([args, expected]) => `{"args": [${args.map((arg) => (Object.is(arg, -0) ? "-0" : JSON.stringify(arg))).join(", ")}], "expected": ${JSON.stringify(expected)}}`).join(", ")}]}`;
    const published = publishedCases(bytes(specOf(text)));
    expect(published.cases.map((c) => c.args)).toEqual(listed.map(([args]) => args));
    expect(published.cases.flatMap((c) => c.args).filter((arg) => Object.is(arg, -0))).toHaveLength(4);
    const total = listed.length;
    const viper = await judgeViper(await pinnedWasm(), bytes(telling), published, 60);
    expect(viper).toMatchObject({ total, passed: total, failures: [] });
    const host = await judgeHost(bytes(telling), published, 20);
    expect(host).toEqual({ engine: HOST_ENGINE, total, passed: total, failures: [] });
    const { judged } = await judgeNode(BOX, bytes(telling), "telling.mjs", published, 7, 60);
    expect(judged).toMatchObject({ engine: NODE_ENGINE, total, passed: total, failures: [] });
  });

  it("one --timeout bounds the whole judgement across every engine", DOCKER_TEST, async () => {
    const onlyInNode = "export default () => { if (import.meta.url !== undefined) for (;;) {} return 1; };\n";
    const four = '{"cases": [{"args": [], "expected": 1}, {"args": [], "expected": 1}, {"args": [], "expected": 1}, {"args": [], "expected": 1}]}';
    const j = await job(onlyInNode, specOf(four), "loop.mjs");
    const keys = { "judge.json": j.judge };
    const timeout = 8;
    const started = Date.now();
    const slow = await cli(judging(j, "--plain-node", "--timeout", String(timeout), "--yes"), keys);
    const took = Date.now() - started;
    expect(slow.code).toBe(EXIT_FAILED);
    expect(slow.json()).toMatchObject({ verdict: "fail", signature: null, cases: { passed: 4 }, host: { passed: 4 }, node: { total: 4, passed: 0 } });
    const node = (slow.json()["node"] as Engine).failures;
    expect(node.map((failure) => failure.verdict)).toEqual(["stopped", "stopped", "stopped", "stopped"]);
    expect(String(node[1]?.detail)).toContain("--timeout");
    expect(took).toBeLessThan((timeout + 4) * 1000);
    expect(status(j.intent)).toBe(IntentStatus.Open);

    const everywhere = "export default () => { for (;;) {} };\n";
    const k = await job(everywhere, specOf(`{"steps": 1000000000, "cases": [{"args": [], "expected": 1}, {"args": [], "expected": 1}, {"args": [], "expected": 1}]}`), "spin.mjs");
    const short = 3;
    const begun = Date.now();
    const stuck = await cli(judging(k, "--plain-node", "--timeout", String(short)), { "judge.json": k.judge });
    const spent = Date.now() - begun;
    expect(stuck.code).toBe(EXIT_FAILED);
    const verdict = stuck.json() as { cases: Engine; host: Engine; node: Engine };
    for (const engine of [verdict.cases, verdict.host, verdict.node]) {
      expect(engine.passed).toBe(0);
      expect(engine.failures.every((failure) => failure.verdict === "stopped")).toBe(true);
    }
    expect(spent).toBeLessThan((short + 4) * 1000);
  });
});

const GUIDE = readFileSync(join(ROOT, "docs/judge.md"), "utf8") + "\n" + readFileSync(join(ROOT, "docs/maintainers/judge-internals.md"), "utf8");
const MISSING_MARK = "Next to plain Node, the host engine lacks exactly these globals:";
const NO_EXTRA = "The host engine adds no globals of its own";

describe("the host engine next to plain Node", () => {
  it("the host engine lacks exactly the globals docs/judge.md lists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-globals-"));
    const probe = join(dir, "globals.mjs");
    await writeFile(probe, "process.stdout.write(Object.getOwnPropertyNames(globalThis).sort().join(' '));\n");
    const plain = execFileSync(process.execPath, [probe], { encoding: "utf8" }).split(" ");
    const host = await judgeHost(bytes("export default () => Object.getOwnPropertyNames(globalThis).sort().join(' ');"), casesOf([{ args: [], expected: "" }]), 20);
    const inHost = String(host.failures[0]?.detail).split(" ");
    expect(inHost).toContain("Intl");
    const listedAfter = (mark: string) => {
      const at = GUIDE.indexOf(mark);
      expect(at, mark).toBeGreaterThan(0);
      return [...GUIDE.slice(at + mark.length, GUIDE.indexOf(".", at + mark.length)).matchAll(/`([^`]+)`/g)].map((match) => match[1] as string).sort();
    };
    expect(listedAfter(MISSING_MARK)).toEqual(plain.filter((name) => !inHost.includes(name)).sort());
    expect(GUIDE).toContain(NO_EXTRA);
    expect(inHost.filter((name) => !plain.includes(name))).toEqual([]);
    const loading = await judgeHost(bytes("const seen = Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith(\"__\")).join(\",\");\nexport default () => seen;"), casesOf([{ args: [], expected: "" }]), 20);
    expect(loading.failures).toEqual([]);
    const meta = await judgeHost(bytes("export default () => String(import.meta.url);"), casesOf([{ args: [], expected: "undefined" }]), 20);
    expect(meta.passed).toBe(1);
  });

  it("judge refuses --plain-node without --sandbox viper before any check runs or anything is paid", async () => {
    const j = await job(WORD_COUNT, WORD_SPEC);
    const keys = { "judge.json": j.judge };
    const marker = join(j.dir, "ran");
    const run = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`;
    const base = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--run", run];
    for (const argv of [
      [...base, "--artifact", j.artifact, "--plain-node"],
      [...base, "--artifact", j.artifact, "--plain-node", "--sandbox", "none"],
      [...base, "--artifact", j.artifact, "--sandbox", "none", "--plain-node", "--yes"],
      [...base, "--watch", "--plain-node", "--sandbox", "none"],
    ]) {
      expect(await cli(argv, keys)).toMatchObject({ code: EXIT_USAGE, err: PLAIN_NODE_ONLY, out: "" });
      expect(existsSync(marker)).toBe(false);
      expect(status(j.intent)).toBe(IntentStatus.Open);
    }
    await cli([...base, "--artifact", j.artifact, "--sandbox", "none"], keys);
    expect(existsSync(marker)).toBe(true);
  });

  it("judge refuses --plain-node without --sandbox viper, and the sandbox options with --sandbox viper but without --plain-node", async () => {
    const j = await job(WORD_COUNT, WORD_SPEC);
    const keys = { "judge.json": j.judge };
    const plainOnly = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--plain-node", "--run", "true"];
    for (const argv of [plainOnly, [...plainOnly, "--sandbox", "docker"], [...plainOnly, "--sandbox", "none"]]) {
      expect(await cli(argv, keys)).toMatchObject({ code: EXIT_USAGE, err: PLAIN_NODE_ONLY });
    }
    for (const [option, value] of [
      ["--sandbox-image", SANDBOX_IMAGE],
      ["--sandbox-memory", "512m"],
      ["--sandbox-cpus", "1"],
    ] as const) {
      expect(await cli(judging(j, option, value), keys)).toMatchObject({ code: EXIT_USAGE, err: sandboxOnly(option.slice(2)) });
    }
    for (const [more, refusal] of [
      [["--sandbox-image", "node:22-bookworm-slim"], IMAGE_NEEDS_DIGEST],
      [["--sandbox-memory", "lots"], MEMORY_FORMAT],
      [["--sandbox-cpus", "0"], CPUS_FORMAT],
      [["--run", "true"], VIPER_TAKES_NO_RUN],
    ] as const) {
      expect(await cli(judging(j, "--plain-node", ...more), keys)).toMatchObject({ code: EXIT_USAGE, err: refusal });
    }
    const empty = await mkdtemp(join(tmpdir(), "judge-no-docker-"));
    const saved = process.env["PATH"];
    process.env["PATH"] = empty;
    try {
      const refused = await cli(judging(j, "--plain-node", "--verdict", join(j.dir, "verdict.json"), "--yes"), keys);
      expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
      expect(refused.err).toContain("docker is not available");
      const viperOnly = await cli(judging(j), keys);
      expect([viperOnly.code, viperOnly.err]).toEqual([EXIT_OK, ""]);
      expect(viperOnly.json()).not.toHaveProperty("node");
    } finally {
      process.env["PATH"] = saved;
    }
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });
});
