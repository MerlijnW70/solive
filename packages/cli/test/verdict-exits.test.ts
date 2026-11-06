import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { RateLimited, TimedOut } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { EXIT_REFUSED, EXIT_RETRY, EXIT_SENT, INFRA_NEXT, infraSkipped } from "../src/judge-errors.js";
import { FAIL_RECEIPT_KIND, readReceipt } from "../src/judge-receipt.js";
import { INFRA_RUNS } from "../src/judge-watch.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { budgeted, JUDGE_SECONDS, overBudget } from "../src/agent/wallet/judge-work.js";
import { containerOutcome, deadlineOf, EXIT_OF, faultOf, stoppedBeforePin } from "../src/verdict-model.js";
import { NOT_TEXT, RUNNER } from "../src/viper.js";
import { announced, keyed } from "./announce.js";
import { cli, funded, h, HOME, NOW, transport, world } from "./harness.js";
import { CORRECT, job, once, run, sha, SPEC_URL, viperWatch } from "./watch-kit.js";

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

const SPEC = '# Count words\n\n```judge-cases\n{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}\n```\n';
const WRONG = "export default function count(text) { return text.length; }\n";
const NOT_UTF8 = Uint8Array.from([0x65, 0x78, 0x70, 0xc3, 0x28, 0xff, 0x0a]);

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function escrow(module: string | Uint8Array, attestor?: Address) {
  const w = await world();
  const judge = await funded();
  const worker = await keyed();
  const dir = await mkdtemp(join(tmpdir(), "verdict-exits-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, module);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: attestor ?? judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  await announced(intent, worker, digest(module), "https://" + "example.org/count.mjs");
  const verdict = join(dir, "verdict.json");
  const argv = (...more: string[]) => ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", "--verdict", verdict, "--yes", ...more];
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  return { judge, intent, dir, spec, verdict, argv, keys: { "judge.json": judge }, status };
}

describe("the exit code of a judge run names its ending", () => {
  for (const output of ["json", "text"]) {
    it(`exits 0 on a pass, 1 on a fail, 75 on infra and 78 on a refusal, with --output ${output}`, async () => {
      const passing = await escrow(CORRECT);
      const passed = await cli(passing.argv("--output", output), passing.keys);
      expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
      expect(passing.status()).toBe(IntentStatus.Filled);

      const failing = await escrow(WRONG);
      const failed = await cli(failing.argv("--output", output), failing.keys);
      expect([failed.code, failed.err]).toEqual([EXIT_FAILED, ""]);
      expect(JSON.parse(readFileSync(failing.verdict, "utf8"))).toMatchObject({ verdict: "fail", signature: null });

      const stalled = await escrow(CORRECT);
      faults.marks.push(RUNNER);
      const infra = await cli(stalled.argv("--output", output), stalled.keys);
      faults.marks.length = 0;
      expect([infra.code, infra.out]).toEqual([EXIT_RETRY, ""]);
      expect(infra.err).toContain(INFRA_NEXT);
      expect(existsSync(stalled.verdict)).toBe(false);

      const other = await keyed();
      const elsewhere = await escrow(CORRECT, other.address);
      const refused = await cli(elsewhere.argv("--output", output), elsewhere.keys);
      expect([refused.code, refused.out, refused.err]).toEqual([EXIT_REFUSED, "", `intent ${elsewhere.intent} names ${other.address} as its judge, not ${elsewhere.judge.address}`]);
      expect(existsSync(elsewhere.verdict)).toBe(false);
      expect(elsewhere.status()).toBe(IntentStatus.Open);

      expect([passed.code, failed.code, infra.code, refused.code]).toEqual([EXIT_OF.pass, EXIT_OF.fail, EXIT_OF.infra, EXIT_OF.refused]);
    });
  }

  it("exits 78, not the 1 of a fail, when an error the judge did not foresee stops it before a verdict", async () => {
    const j = await escrow(CORRECT);
    h.through = { ...transport, getAccount: async () => Promise.reject(new Error("the node answered something the judge cannot read")) };
    const stopped = await cli(j.argv(), j.keys);
    expect([stopped.code, stopped.out, stopped.err]).toEqual([EXIT_REFUSED, "", "the node answered something the judge cannot read"]);
    expect(existsSync(j.verdict)).toBe(false);
  });

  it("exits 75 when the RPC node rate-limits a judge run, since the failure passes", async () => {
    const j = await escrow(CORRECT);
    h.through = { ...transport, getAccount: async () => Promise.reject(new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 })) };
    const limited = await cli(j.argv(), j.keys);
    expect([limited.code, limited.out]).toEqual([EXIT_RETRY, ""]);
    expect(existsSync(j.verdict)).toBe(false);
    expect(j.status()).toBe(IntentStatus.Open);
  });

  it("exits 75 when the RPC node does not answer in time or rate-limits through the client's limits, before anything is signed", async () => {
    for (const late of [new TimedOut("getAccountInfo", 30_000), new RateLimited("getAccountInfo", null)]) {
      const j = await escrow(CORRECT);
      h.through = { ...transport, getAccount: async () => Promise.reject(late) };
      const stalled = await cli(j.argv(), j.keys);
      expect([stalled.code, stalled.out, stalled.err], late.message).toEqual([EXIT_RETRY, "", late.message]);
      expect(existsSync(j.verdict)).toBe(false);
      h.through = null;
    }
  });

  it("does not exit 76 when signing the release fails, since nothing was signed or sent", async () => {
    const j = await escrow(CORRECT);
    const refusing = { ...j.judge, signTransactions: async () => Promise.reject(new Error("the signer refused to sign")) };
    const refused = await cli(j.argv(), { "judge.json": refusing });
    expect([refused.code, refused.out, refused.err]).toEqual([EXIT_REFUSED, "", "the signer refused to sign"]);
    expect(j.status()).toBe(IntentStatus.Open);
  });

  it("exits 75 when the spec url cannot be read for now, which a later run may read", async () => {
    const j = await job({ specUrl: SPEC_URL });
    h.specReplies.set(SPEC_URL, async () => {
      throw new TypeError("fetch failed");
    });
    const unread = await cli([...once(j, "--artifact", j.work), "--sandbox", "viper", "--yes"], { "judge.json": j.judge });
    expect([unread.code, unread.out]).toEqual([EXIT_RETRY, ""]);
    expect(unread.err).toContain(`who the job ${j.intent} invites cannot be checked`);
  });

  it("exits 2 when a file named on the command line is missing", async () => {
    const j = await escrow(CORRECT);
    const missing = join(j.dir, "missing.md");
    const stopped = await cli(j.argv().map((arg) => (arg === j.spec ? missing : arg)), j.keys);
    expect([stopped.code, stopped.out]).toEqual([EXIT_USAGE, ""]);
    expect(stopped.err).toContain("ENOENT");
    expect(existsSync(j.verdict)).toBe(false);
  });

  it("exits 76 and names the intent to read when the release was sent but its send failed after the broadcast", async () => {
    const j = await escrow(CORRECT);
    h.through = {
      ...transport,
      send: async (ixs, payer) => {
        await transport.send(ixs, payer);
        throw new Error("the connection closed");
      },
    };
    const unsure = await cli(j.argv(), j.keys);
    expect([unsure.code, unsure.out]).toEqual([EXIT_SENT, ""]);
    expect(unsure.err).toContain("so the release may have landed");
    expect(unsure.err).toContain(`Read intent ${j.intent} before judging it again`);
    expect(unsure.err).not.toContain("nothing was signed");
    expect(existsSync(j.verdict)).toBe(false);
    expect(j.status()).toBe(IntentStatus.Filled);
  });

  it("refuses a run whose --verdict cannot be written before it runs or sends anything", async () => {
    const j = await escrow(CORRECT);
    const nowhere = join(j.dir, "gone", "verdict.json");
    const stopped = await cli(j.argv().map((arg) => (arg === j.verdict ? nowhere : arg)), j.keys);
    expect([stopped.code, stopped.out]).toEqual([EXIT_USAGE, ""]);
    expect(j.status()).toBe(IntentStatus.Open);
  });
});

describe("other commands keep their exit codes for a refusal", () => {
  it("hash --artifact on a path that is neither a file nor a directory still exits 1", { skip: process.platform === "win32" }, async () => {
    const hashed = await cli(["hash", "--artifact", "/dev/null"], {});
    expect([hashed.code, hashed.out, hashed.err]).toEqual([EXIT_FAILED, "", "--artifact /dev/null is neither a regular file nor a directory"]);
  });
});

describe("announced work that is not UTF-8 text", () => {
  it("is refused, not judged: exit 78, no verdict, no fail receipt, nothing paid", async () => {
    const j = await escrow(NOT_UTF8);
    const refused = await cli(j.argv(), j.keys);
    expect([refused.code, refused.out, refused.err]).toEqual([EXIT_REFUSED, "", NOT_TEXT]);
    expect(existsSync(j.verdict)).toBe(false);
    const announcement = (await createClient({ url: "http://cluster", transport }).announcements(j.intent)).announcements[0]?.address as Address;
    const at = { cluster: await transport.genesisHash(), judge: j.judge.address, intent: j.intent, announcement, deliveredSha256: digest(NOT_UTF8) };
    await expect(readReceipt(HOME, at, {}, FAIL_RECEIPT_KIND)).rejects.toThrow();
    expect(j.status()).toBe(IntentStatus.Open);
  });
});

describe("the labels of judge --watch lines", () => {
  it("labels an engine that crashes infra, a spec url that cannot be read for now deferred, and a spec url gone for good refused", async () => {
    const crashing = await job();
    faults.marks.push(RUNNER);
    const stalled = await run(viperWatch(crashing), { rounds: 8 });
    faults.marks.length = 0;
    expect(stalled.code).toBe(EXIT_OK);
    const last = String(stalled.lines[0]?.["reason"]);
    expect(last).toContain("infrastructure error, not a verdict: the viper judge process ended with exit code 9");
    expect(stalled.lines.slice(0, 2)).toEqual([
      expect.objectContaining({ outcome: "infra", verdict: "retry", retry: true, reason: last }),
      expect.objectContaining({ outcome: "infra", verdict: "skipped", reason: infraSkipped(INFRA_RUNS, last) }),
    ]);

    const unread = await job({ specUrl: SPEC_URL });
    h.specReplies.set(SPEC_URL, async () => {
      throw new TypeError("fetch failed");
    });
    const deferred = await run(viperWatch(unread), { rounds: 2 });
    expect(deferred.lines[0]).toMatchObject({ artifactSha256: sha(CORRECT), outcome: "deferred", verdict: "retry", retry: true });

    const gone = await job({ specUrl: SPEC_URL });
    h.specReplies.set(SPEC_URL, async () => new Response("gone", { status: 404 }));
    const refused = await run(viperWatch(gone), { rounds: 2 });
    expect(refused.lines[0]).toMatchObject({ artifactSha256: sha(CORRECT), verdict: "refused" });
    expect(refused.lines[0]).not.toHaveProperty("outcome");
    expect(refused.lines[0]).not.toHaveProperty("retry");
  }, 120_000);
});

describe("a message names the setting that applies", () => {
  it("names the pinned timeout, not --timeout, when a judge-run block pins it and the judge's deadline came first", () => {
    const limits = { seconds: 90, memory: "1g", pinned: { seconds: 60 } };
    expect(containerOutcome({ deadline: true, state: null }, limits)).toEqual({ outcome: "infra", reason: stoppedBeforePin(90, 60) });
    expect(stoppedBeforePin(90, 60)).toContain("the 60 second timeout the spec's judge-run block pins");
    expect(stoppedBeforePin(90, 60)).not.toContain("--timeout");
  });

  it("names the tool's own budget, not a --timeout it does not take, when an engine runs out of time in wallet_judge_work", () => {
    const late = { total: 2, passed: 0, failures: [], stop: deadlineOf("the viper judge did not finish within the 10 ms left of the judgement's --timeout", 2) };
    expect(budgeted("the viper judge", late).stop).toEqual({ cause: "deadline", reason: overBudget("the viper judge"), unfinished: 2 });
    expect(overBudget("the viper judge")).toContain(`${JUDGE_SECONDS} second budget`);
    expect(overBudget("the viper judge")).not.toContain("--timeout");
    const crashed = { total: 2, passed: 0, failures: [], stop: faultOf("the viper judge crashed", 2) };
    expect(budgeted("the viper judge", crashed)).toBe(crashed);
  });
});
