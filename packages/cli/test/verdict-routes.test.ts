import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { EXIT_RETRY, INFRA_NEXT } from "../src/judge-errors.js";
import { INFRA_RUNS } from "../src/judge-watch.js";
import { HOST_RUNNER } from "../src/host-judge.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { RUNNER } from "../src/viper.js";
import { endedBy, exitedWith } from "../src/verdict-model.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, funded, h, NOW, transport, type World, world } from "./harness.js";
import { job as judgeJob, judging as shellJudging, paidTo as shellPaid, status as shellStatus } from "./judge-kit.js";
import { job as watchJob, paidTo as watchPaid, run, status as watchStatus, viperWatch } from "./watch-kit.js";

const faults = vi.hoisted(() => ({ marks: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [, args, options] = all as unknown as [string, unknown, object | undefined];
    const broken = Array.isArray(args) && faults.marks.some((mark) => args.includes(mark));
    return broken ? actual.spawn(process.execPath, ["-e", "process.exit(9)"], options ?? {}) : actual.spawn(...all);
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

afterEach(() => {
  faults.marks.length = 0;
});

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WRONG = "export default function count(text) { return text.length; }\n";
const HOST_ONLY_LOOP = "export default function count(text) { if (typeof Intl !== 'undefined') for (;;) {} const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const VIPER_CRASH = "infrastructure error, not a verdict: the viper judge process ended with exit code 9";
const HOST_CRASH = "infrastructure error, not a verdict: the host engine ended with exit code 9";

async function escrow(module: string, at: { attestor?: Address; w?: World; nonce?: bigint } = {}) {
  const w = at.w ?? (await world());
  const nonce = at.nonce ?? 0n;
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "verdict-routes-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: at.attestor ?? judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce, expiresAt: NOW + 3_600n });
  await announced(intent, worker, sha(module), "https://" + "example.org/count.mjs");
  const argv = (keypair: string, ...more: string[]) => ["judge", "--keypair", keypair, "--owner", w.owner.address, "--nonce", String(nonce), "--spec", spec, "--artifact", artifact, "--sandbox", "viper", ...more];
  const paid = async () => balance(await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  return { w, judge, worker, dir, intent, argv, paid, status };
}

describe("judge --sandbox viper ends in pass, fail or infra through one classifier", () => {
  it("pays a pass, fails a wrong delivery, and signs nothing on either a fail or infra", async () => {
    const good = await escrow(CORRECT);
    const keys = { "judge.json": good.judge };
    const paid = await cli(good.argv("judge.json", "--yes"), keys);
    expect([paid.code, paid.err, paid.json()["verdict"]]).toEqual([EXIT_OK, "", "pass"]);
    expect(good.status()).toBe(IntentStatus.Filled);

    const bad = await escrow(WRONG);
    const failed = await cli(bad.argv("judge.json", "--yes"), { "judge.json": bad.judge });
    expect([failed.code, failed.json()["verdict"], failed.json()["signature"]]).toEqual([EXIT_FAILED, "fail", null]);
    expect(bad.status()).toBe(IntentStatus.Open);
  });

  it("makes a viper engine that crashes infra: exit 75, no verdict file, nothing signed", async () => {
    const j = await escrow(CORRECT);
    const verdict = join(j.dir, "verdict.json");
    faults.marks.push(RUNNER);
    const crashed = await cli(j.argv("judge.json", "--verdict", verdict, "--yes"), { "judge.json": j.judge });
    expect([crashed.code, crashed.out]).toEqual([EXIT_RETRY, ""]);
    expect(crashed.err).toContain(VIPER_CRASH);
    expect(crashed.err).toContain(INFRA_NEXT);
    expect(existsSync(verdict)).toBe(false);
    expect(j.status()).toBe(IntentStatus.Open);
    expect(await j.paid()).toBe(-1n);
  });

  it("makes a host engine that crashes infra, unless another engine showed the work fail a case", async () => {
    const j = await escrow(CORRECT);
    faults.marks.push(HOST_RUNNER);
    const crashed = await cli(j.argv("judge.json", "--yes"), { "judge.json": j.judge });
    expect([crashed.code, crashed.out]).toEqual([EXIT_RETRY, ""]);
    expect(crashed.err).toContain(HOST_CRASH);
    expect(j.status()).toBe(IntentStatus.Open);

    const k = await escrow(WRONG);
    const failed = await cli(k.argv("judge.json", "--yes"), { "judge.json": k.judge });
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null, cases: { passed: 1 }, host: { passed: 0, failures: [], stop: { cause: "fault", unfinished: 2 } } });
    expect(k.status()).toBe(IntentStatus.Open);
  });

  it("fails a delivery whose top-level code can never finish loading in the host engine, and signs nothing", async () => {
    const j = await escrow("if (typeof Intl !== 'undefined') await new Promise(() => {});\n" + CORRECT);
    const failed = await cli(j.argv("judge.json", "--yes"), { "judge.json": j.judge });
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null, cases: { passed: 2 }, host: { passed: 0 } });
    expect((failed.json()["host"] as { failures: unknown[] }).failures[0]).toMatchObject({ case: 0, verdict: "no-module" });
    expect(j.status()).toBe(IntentStatus.Open);
  });

  it("makes a judgement whose --timeout runs out in an engine infra, even when the work loops there on purpose", async () => {
    const j = await escrow(HOST_ONLY_LOOP);
    const verdict = join(j.dir, "verdict.json");
    const late = await cli(j.argv("judge.json", "--timeout", "1", "--verdict", verdict, "--yes"), { "judge.json": j.judge });
    expect([late.code, late.out]).toEqual([EXIT_RETRY, ""]);
    expect(late.err).toMatch(/infrastructure error, not a verdict: the (viper judge|host engine) did not finish within/);
    expect(existsSync(verdict)).toBe(false);
    expect(j.status()).toBe(IntentStatus.Open);
  });
});

async function panel() {
  const members = await Promise.all([0, 1, 2].map(() => funded()));
  const payer = await funded();
  const keys: Record<string, KeyPairSigner> = { "payer.json": payer };
  members.forEach((member, at) => (keys[`m${at}.json`] = member));
  const feeWallet = (await generateKeyPairSigner()).address;
  const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", sortMembers(members.map((m) => m.address)).join(","), "--threshold", "2", "--fee-wallet", feeWallet, "--yes"], keys);
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  return { keys, committee: created.json()["committee"] as Address };
}

describe("a committee member's judge uses the same classifier", () => {
  it("votes only on a pass, and neither a fail nor infra writes a vote", async () => {
    const w = await world();
    const { keys, committee } = await panel();
    const good = await escrow(CORRECT, { attestor: committee, w, nonce: 0n });
    const all = { ...keys, "judge.json": good.judge };
    const voted = join(good.dir, "m0.verdict");
    const pass = await cli(good.argv("m0.json", "--verdict", voted), all);
    expect([pass.code, pass.err, pass.json()["verdict"]]).toEqual([EXIT_OK, "", "pass"]);
    expect(pass.json()).toHaveProperty("vote");

    faults.marks.push(RUNNER);
    const stalled = join(good.dir, "m1.verdict");
    const crashed = await cli(good.argv("m1.json", "--verdict", stalled), all);
    expect([crashed.code, crashed.out]).toEqual([EXIT_RETRY, ""]);
    expect(crashed.err).toContain(VIPER_CRASH);
    expect(existsSync(stalled)).toBe(false);
    faults.marks.length = 0;

    const bad = await escrow(WRONG, { attestor: committee, w, nonce: 1n });
    const refused = join(bad.dir, "m2.verdict");
    const failed = await cli(bad.argv("m2.json", "--verdict", refused), { ...keys, "judge.json": bad.judge });
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null });
    expect(failed.json()).not.toHaveProperty("vote");
    expect(good.status()).toBe(IntentStatus.Open);
  });
});

describe("judge --watch uses the same classifier", () => {
  it("retries infra, gives the work up after its limit, never pays it, and pays once the engine works", async () => {
    const j = await watchJob();
    faults.marks.push(RUNNER);
    const stalled = await run(viperWatch(j), { rounds: INFRA_RUNS + 2 });
    expect(stalled.code).toBe(EXIT_OK);
    const verdicts = stalled.lines.map((line) => line["verdict"] ?? line["stopped"]);
    expect(verdicts).toEqual(["retry", "skipped", "ended"]);
    expect(stalled.lines[1]?.["reason"]).toContain(`${INFRA_RUNS} times`);
    expect(String(stalled.lines[0]?.["reason"])).toContain(VIPER_CRASH);
    expect(watchStatus(j.intent)).toBe(IntentStatus.Open);
    expect(await watchPaid(j)).toBe(-1n);

    faults.marks.length = 0;
    const k = await watchJob();
    const paid = await run(viperWatch(k));
    expect(paid.lines.map((line) => line["verdict"] ?? line["stopped"])).toEqual(["pass", "paid"]);
    expect(watchStatus(k.intent)).toBe(IntentStatus.Filled);
  }, 120_000);
});

describe("judge --sandbox none lets the check's own exit decide", () => {
  it("fails a check that kills itself or exits 75 or 125, signs nothing, and never turns it into infra", async () => {
    for (const [run, reason] of [
      ["kill -KILL $$", endedBy("SIGKILL")],
      ["exit 75", exitedWith(75)],
      ["echo 'docker: Error response from daemon: OCI runtime create failed' >&2; exit 125", exitedWith(125)],
    ] as const) {
      const j = await judgeJob();
      const failed = await cli(shellJudging(j, run, "--yes"), { "judge.json": j.judge });
      expect([failed.code, failed.json()["verdict"], failed.json()["signature"]], reason).toEqual([EXIT_FAILED, "fail", null]);
      expect(shellStatus(j.intent), run).toBe(IntentStatus.Open);
      expect(await shellPaid(j, j.worker.address), run).toBe(-1n);
    }
  });
});
