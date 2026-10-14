import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, type Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEvent, deliveryMemo, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, manifestSha256, RELEASE_MEMO_PREFIX, releaseMemo } from "@intent-engine/core";
import { createClient, DELIVERY_PAGES, DELIVERY_SCAN, type EngineTransaction, type ListedSignature, SIGNATURE_PAGE, type Transport } from "@intent-engine/client";
import { ENV_KEYPAIR, JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, RUN_NEEDED } from "../src/args.js";
import { NOT_SENT } from "../src/flows.js";
import {
  artifactSha256,
  CHECK_ENV,
  checkEnv,
  claim,
  CLEANUP_RETRIES,
  ENV_ARTIFACT_PATH,
  ENV_ARTIFACT_SHA256,
  ENV_SPEC_PATH,
  leftRunning,
  type Recorded,
  resultOutside,
  runCheck,
  type Running,
  SKIPPED,
  SPEC_COPY,
} from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { balance, cli, creation, funded, h, NOW, transport, type World, world } from "./harness.js";

const removal = vi.hoisted(() => ({ refused: false, retries: [] as (number | undefined)[] }));
const writing = vi.hoisted(() => ({ before: null as ((path: string) => Promise<void>) | null }));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await writing.before?.(String(args[0]));
      return actual.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const [path, options] = args;
      if (removal.refused && String(path).includes("judge-artifact-")) {
        removal.retries.push(options?.maxRetries);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(path)}'`), { code: "EBUSY" });
      }
      return actual.rm(...args);
    },
  };
});

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

async function job(specText = SPEC, workSha256?: string): Promise<Job> {
  const w = await world();
  const judge = await funded();
  const worker = await generateKeyPairSigner();
  const copier = await generateKeyPairSigner();
  const dir = await mkdtemp(join(tmpdir(), "judge-"));
  const spec = join(dir, "spec.md");
  await writeFile(spec, specText);
  const artifact = join(dir, "work");
  for (const skipped of [".git", "node_modules", "target"]) {
    await mkdir(join(artifact, skipped), { recursive: true });
    await writeFile(join(artifact, skipped, "ignored"), "not hashed");
  }
  await mkdir(join(artifact, "src"), { recursive: true });
  await writeFile(join(artifact, "answer.txt"), "42\n");
  await writeFile(join(artifact, "src", "notes.txt"), "how\n");
  const sha256 =
    workSha256 ??
    (await manifestSha256([
      { path: "answer.txt", bytes: new TextEncoder().encode("42\n") },
      { path: "src/notes.txt", bytes: new TextEncoder().encode("how\n") },
    ]));
  const specHash = new Uint8Array(createHash("sha256").update(specText).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [announced(intent, copier.address, sha256, "copy", 9n, "https://example.org/stolen"), announced(intent, worker.address, sha256, "first", 5n), creation(intent)];
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

const FLOOD = "flood-";

function flooding(judge: Address, count: number): Transport {
  const listed = (): ListedSignature[] =>
    h.engineLog.map(({ signature, slot, blockTime, failed, memos }) => ({ signature, slot, blockTime, failed, memo: memos === undefined ? null : memos.join("; ") }));
  const real = (limit: number, before?: string) => {
    const all = listed();
    const start = before === undefined ? 0 : all.findIndex(({ signature }) => signature === before) + 1;
    return all.slice(start, start + limit);
  };
  return {
    ...transport,
    signaturesOf: async (of, limit, before) => {
      const at = before === undefined ? 0 : before.startsWith(FLOOD) ? Number(before.slice(FLOOD.length)) + 1 : null;
      if (of !== judge || at === null) {
        return real(limit, before);
      }
      const n = Math.max(0, Math.min(limit, count - at));
      const fake = Array.from({ length: n }, (_, i): ListedSignature => ({ signature: `${FLOOD}${at + i}`, slot: 30n, blockTime: null, failed: false, memo: null }));
      return n < limit ? [...fake, ...real(limit - n)] : fake;
    },
    transactionsOf: async (wanted) => wanted.flatMap(({ signature }) => h.engineLog.filter((entry) => entry.signature === signature)),
  };
}

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

  it("judge refuses a result outside the escrow bounds before running the check", async () => {
    const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 5n, attestor: j.judge.address, specHash, judgeFee: 0n } as const;
    const client = createClient({ url: "http://cluster", transport });
    const { intent } = await client.createIntent({ signer: j.w.owner, params, inputMint: j.w.inputMint, outputMint: j.w.outputMint, nonce: 1n, expiresAt: NOW + 3_600n });
    h.engineLog = [announced(intent, j.worker.address, j.sha256, "first-of-one", 5n), creation(intent)];
    const ran = join(j.dir, "ran");
    const run = `touch "${ran}"`;
    const onNonce = (...more: string[]) => {
      const args = judging(j, run, ...more);
      args[args.indexOf("--nonce") + 1] = "1";
      return args;
    };
    for (const result of [1n, 6n]) {
      const refused = await cli(onNonce("--result", String(result), "--yes"), keys);
      expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
      expect(refused.err).toBe(resultOutside(result, intent, 2n, 5n));
      expect(existsSync(ran)).toBe(false);
    }
    expect(status(intent)).toBe(IntentStatus.Open);
    const chosen = await cli(onNonce("--result", "3"), keys);
    expect([chosen.code, chosen.err]).toEqual([EXIT_OK, ""]);
    expect(chosen.json()).toMatchObject({ intent, verdict: "pass", signature: null, next: NOT_SENT });
    expect(existsSync(ran)).toBe(true);
    const paid = await cli(onNonce("--yes"), keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ intent, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(paid.json()).not.toHaveProperty("next");
    expect(status(intent)).toBe(IntentStatus.Filled);
    const landed = h.svm.getTransaction(paid.json()["signature"] as Signature);
    if (!(landed instanceof TransactionMetadata)) {
      throw new Error("the settle did not land");
    }
    expect(landed.logs().some((line) => line.includes(releaseMemo(j.sha256)))).toBe(true);
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
  });

  it("judge settles with the given result", async () => {
    const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 5n, attestor: j.judge.address, specHash, judgeFee: 0n } as const;
    const client = createClient({ url: "http://cluster", transport });
    const { intent } = await client.createIntent({ signer: j.w.owner, params, inputMint: j.w.inputMint, outputMint: j.w.outputMint, nonce: 2n, expiresAt: NOW + 3_600n });
    h.engineLog = [announced(intent, j.worker.address, j.sha256, "first-of-two", 5n), creation(intent)];
    const verdict = join(j.dir, "result.json");
    const args = judging(j, "true", "--result", "4", "--verdict", verdict, "--yes");
    args[args.indexOf("--nonce") + 1] = "2";
    const paid = await cli(args, keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ intent, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(paid.json()).not.toHaveProperty("next");
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(paid.json());
    expect(status(intent)).toBe(IntentStatus.Filled);
    const landed = h.svm.getTransaction(paid.json()["signature"] as Signature);
    if (!(landed instanceof TransactionMetadata)) {
      throw new Error("the settle did not land");
    }
    const events = landed
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(new Uint8Array(inner.instruction().data())))
      .filter((event) => event !== null);
    const attested = events.find((event) => event.name === "IntentAttested");
    expect(attested?.fields).toMatchObject({ intent, result: 4n });
  });

  it("an interrupted check never passes", async () => {
    const started = join(j.dir, "started");
    const root = join(j.dir, "root");
    const verdict = join(j.dir, "interrupted.json");
    const run = `pwd > "${root}"; touch "${started}"; trap 'exit 0' INT TERM; sleep 2; exit 0`;
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      await rm(started, { force: true });
      const others = process.listeners(signal);
      process.removeAllListeners(signal);
      try {
        const running = cli(judging(j, run, "--verdict", verdict, "--yes"), keys);
        for (let waited = 0; !existsSync(started) && waited < 200; waited++) {
          await new Promise((wake) => setTimeout(wake, 25));
        }
        expect(existsSync(started)).toBe(true);
        process.emit(signal, signal);
        const ended = await running;
        expect([ended.code, ended.out]).toEqual([code, ""]);
        expect(ended.err).toContain(`the check was interrupted by ${signal}; nothing was paid and no verdict was written`);
      } finally {
        for (const listener of others) {
          process.on(signal, listener as NodeJS.SignalsListener);
        }
      }
      expect(existsSync(verdict)).toBe(false);
      expect(existsSync((await readFile(root, "utf8")).trim())).toBe(false);
      expect(status(j.intent)).toBe(IntentStatus.Open);
      expect(await paidTo(j, j.worker.address)).toBe(-1n);
    }
  });

  it("a second interrupt during settlement still reports the signature", async () => {
    const verdict = join(j.dir, "verdict.json");
    const others = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    const exits = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const sent: string[] = [];
      h.through = {
        ...transport,
        send: async (ixs, payer) => {
          const signature = await transport.send(ixs, payer);
          sent.push(signature);
          process.emit("SIGINT", "SIGINT");
          return signature;
        },
      };
      const ended = await cli(judging(j, "true", "--verdict", verdict, "--yes"), keys);
      expect(sent).toHaveLength(1);
      expect([ended.code, ended.out]).toEqual([130, ""]);
      expect(ended.err).toContain(`SIGINT arrived while the release was being sent; it was sent in ${sent[0]}`);
      expect(JSON.parse(await readFile(verdict, "utf8"))).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: sent[0] });
      expect(status(j.intent)).toBe(IntentStatus.Filled);
      expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);

      const twice = await job();
      const landed: string[] = [];
      h.through = {
        ...transport,
        send: async (ixs, payer) => {
          landed.push(await transport.send(ixs, payer));
          process.emit("SIGINT", "SIGINT");
          process.emit("SIGINT", "SIGINT");
          return new Promise<string>(() => undefined);
        },
      };
      await writeFile(verdict, "stale");
      const stopped = await cli(judging(twice, "true", "--verdict", verdict, "--yes"), { "judge.json": twice.judge });
      expect(landed).toHaveLength(1);
      expect([stopped.code, stopped.out]).toEqual([130, ""]);
      expect(stopped.err).toContain(`the release was sent in ${landed[0]}; a second SIGINT stopped the judge before the send was confirmed, so the release may have landed`);
      expect(existsSync(verdict)).toBe(false);
      expect(status(twice.intent)).toBe(IntentStatus.Filled);
      await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(130));

      const again = await job();
      h.through = {
        ...transport,
        send: async (_ixs, payer) => {
          await (payer as KeyPairSigner).signTransactions([]);
          process.emit("SIGINT", "SIGINT");
          throw new Error("the node went away");
        },
      };
      await writeFile(verdict, "stale");
      const lost = await cli(judging(again, "true", "--verdict", verdict, "--yes"), { "judge.json": again.judge });
      expect([lost.code, lost.out]).toEqual([130, ""]);
      expect(lost.err).toContain("the release may have landed: the node went away");
      expect(existsSync(verdict)).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(0);
    } finally {
      h.through = null;
      exits.mockRestore();
      for (const listener of others) {
        process.on("SIGINT", listener as NodeJS.SignalsListener);
      }
    }
  });

  it("interrupts after the release confirms still write the verdict", async () => {
    const verdict = join(j.dir, "verdict.json");
    const others = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    const exits = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      let emitted = false;
      writing.before = async (path) => {
        if (path !== verdict) {
          return;
        }
        writing.before = null;
        emitted = true;
        process.emit("SIGINT", "SIGINT");
        process.emit("SIGINT", "SIGINT");
        await new Promise((wake) => setTimeout(wake, 500));
      };
      const ended = await cli(judging(j, "true", "--verdict", verdict, "--yes"), keys);
      expect(emitted).toBe(true);
      expect([ended.code, ended.out]).toEqual([130, ""]);
      const written = JSON.parse(await readFile(verdict, "utf8"));
      expect(written).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
      expect(ended.err).toContain(`it was sent in ${written.signature} and the verdict was written to ${verdict}`);
      expect(ended.err).not.toContain("may have landed");
      await new Promise((wake) => setTimeout(wake, 300));
      expect(exits).not.toHaveBeenCalled();
      expect(status(j.intent)).toBe(IntentStatus.Filled);
      expect(process.listenerCount("SIGINT")).toBe(0);
    } finally {
      writing.before = null;
      exits.mockRestore();
      for (const listener of others) {
        process.on("SIGINT", listener as NodeJS.SignalsListener);
      }
    }
  });

  it("an interrupt before sending pays nothing", async () => {
    const verdict = join(j.dir, "verdict.json");
    for (const [signal, code, at] of [["SIGINT", 130, "send"], ["SIGTERM", 143, "read"]] as const) {
      const run = at === "send" ? j : await job();
      const marker = join(run.dir, "checked");
      const others = process.listeners(signal);
      process.removeAllListeners(signal);
      const attempts: string[] = [];
      let emitted = false;
      try {
        h.through = {
          ...transport,
          getAccount: async (address) => {
            if (at === "read" && !emitted && address === run.worker.address && existsSync(marker)) {
              emitted = true;
              process.emit(signal, signal);
            }
            return transport.getAccount(address);
          },
          send: async (ixs, payer) => {
            if (at === "send" && !emitted) {
              emitted = true;
              process.emit(signal, signal);
            }
            try {
              return await transport.send(ixs, payer);
            } catch (error) {
              attempts.push(String(error));
              throw error;
            }
          },
        };
        await writeFile(verdict, "stale");
        const ended = await cli(judging(run, `touch "${marker}"`, "--verdict", verdict, "--yes"), { "judge.json": run.judge });
        expect(emitted).toBe(true);
        expect([ended.code, ended.out]).toEqual([code, ""]);
        expect(ended.err).toContain(`the check passed, but ${signal} arrived before the release was sent; nothing was paid and no verdict was written`);
        expect(process.listenerCount(signal)).toBe(0);
        await new Promise((wake) => setTimeout(wake, 100));
      } finally {
        h.through = null;
        for (const listener of others) {
          process.on(signal, listener as NodeJS.SignalsListener);
        }
      }
      expect(existsSync(verdict)).toBe(false);
      expect(status(run.intent)).toBe(IntentStatus.Open);
      expect(await paidTo(run, run.worker.address)).toBe(-1n);
      expect(attempts.length).toBeLessThanOrEqual(1);
    }
  });

  it("a refused run removes a stale verdict file", async () => {
    const verdict = join(j.dir, "verdict.json");
    const stale = `${JSON.stringify({ intent: j.intent, verdict: "pass", signature: null })}\n`;
    const marker = join(j.dir, "ran");
    const run = `touch "${marker}"`;
    await writeFile(join(j.dir, "other.md"), "a different spec\n");
    const refusals = [
      [...judging(j, run, "--verdict", verdict).slice(0, 7), "--spec", join(j.dir, "other.md"), ...judging(j, run, "--verdict", verdict).slice(9)],
      judging(j, run, "--verdict", verdict, "--pay-to", j.copier.address),
      judging(j, run, "--verdict", verdict, "--result", "7"),
    ];
    for (const argv of refusals) {
      await writeFile(verdict, stale);
      const refused = await cli(argv, keys);
      expect(refused.code).toBe(EXIT_FAILED);
      expect(existsSync(verdict)).toBe(false);
    }
    await writeFile(verdict, stale);
    const stranger = await funded();
    const foreign = await cli(judging(j, run, "--verdict", verdict), { "judge.json": stranger });
    expect(foreign.err).toContain(`not ${stranger.address}`);
    expect(existsSync(verdict)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("a judge timeout also kills a delivery in its own process group", { timeout: 60_000 }, async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = async (pid: number) => {
      for (let tries = 0; tries < 100 && alive(pid); tries++) {
        await new Promise((wake) => setTimeout(wake, 20));
      }
      return !alive(pid);
    };
    const grouped = join(j.dir, "grouped");
    const own = `perl -e 'setpgrp(0, 0); open(my $f, ">", $ARGV[0]) or die; print $f "$$ " . getpgrp(); close $f; exec "sleep", "600"' "${grouped}" & wait`;
    const slow = await cli(judging(j, own, "--timeout", String(TIMEOUT_SECONDS), "--yes"), keys);
    expect(slow.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null });
    const [pid = 0, group] = (await readFile(grouped, "utf8")).split(" ").map(Number);
    expect(group).toBe(pid);
    expect(await gone(pid)).toBe(true);

    const example = join(ROOT, "examples/jobs/word-count");
    const pids = await mkdtemp(join(tmpdir(), "judge-loop-pid-"));
    const pidFile = join(pids, "delivery");
    const looping = await mkdtemp(join(tmpdir(), "judge-loop-"));
    await writeFile(
      join(looping, "wordcount.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nexport default function count() {\n  for (;;) {}\n}\n`,
    );
    const loop = await job(await readFile(join(example, "SPEC.md"), "utf8"), await artifactSha256(looping));
    const ended = await cli(judging({ ...loop, artifact: looping }, `node '${join(example, "check.mjs")}'`, "--timeout", "3", "--yes"), { "judge.json": loop.judge });
    expect(ended.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null });
    const delivery = Number(await readFile(pidFile, "utf8"));
    expect(delivery).toBeGreaterThan(0);
    const killed = await gone(delivery);
    if (!killed) {
      process.kill(delivery, "SIGKILL");
    }
    expect(killed).toBe(true);
    expect(status(loop.intent)).toBe(IntentStatus.Open);
  });

  it("a stale verdict file is removed before the check", async () => {
    const verdict = join(j.dir, "verdict.json");
    const seen = join(j.dir, "seen");
    const stale = `${JSON.stringify({ intent: j.intent, verdict: "pass", signature: null })}\n`;
    await writeFile(verdict, stale);
    const failed = await cli(judging(j, `if test -e "${verdict}"; then echo present > "${seen}"; else echo absent > "${seen}"; fi; exit 3`, "--verdict", verdict, "--yes"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect((await readFile(seen, "utf8")).trim()).toBe("absent");
    expect(JSON.parse(await readFile(verdict, "utf8"))).toMatchObject({ verdict: "fail", exitCode: 3 });

    await writeFile(verdict, stale);
    const started = join(j.dir, "started");
    const others = process.listeners("SIGTERM");
    process.removeAllListeners("SIGTERM");
    try {
      const running = cli(judging(j, `touch "${started}"; sleep 2; exit 0`, "--verdict", verdict, "--yes"), keys);
      for (let waited = 0; !existsSync(started) && waited < 200; waited++) {
        await new Promise((wake) => setTimeout(wake, 25));
      }
      expect(existsSync(verdict)).toBe(false);
      process.emit("SIGTERM", "SIGTERM");
      expect((await running).code).toBe(143);
    } finally {
      for (const listener of others) {
        process.on("SIGTERM", listener as NodeJS.SignalsListener);
      }
    }
    expect(existsSync(verdict)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
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

    h.engineLog = [announced(j.intent, j.worker.address, "cd".repeat(32), "other", 2n), creation(j.intent)];
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
    h.engineLog = [announced(j.intent, j.worker.address, sha256, "single", 3n), creation(j.intent)];
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
    const run = await cli(judging(j, check, "--pay-to", j.worker.address), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", artifactSha256: await artifactSha256(j.artifact) });
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

  it("a cleanup failure does not hide the verdict", async () => {
    const seen = join(j.dir, "seen");
    removal.retries = [];
    removal.refused = true;
    const run = await cli(judging(j, `pwd -P > "${seen}"`, "--verdict", join(j.dir, "verdict.json")), keys).finally(() => {
      removal.refused = false;
    });
    const copy = (await readFile(seen, "utf8")).trim();
    expect(existsSync(copy)).toBe(true);
    await rm(copy, { recursive: true, force: true });
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", exitCode: 0, payTo: j.worker.address, cleanup: expect.stringContaining("could not be removed") });
    expect(JSON.parse(await readFile(join(j.dir, "verdict.json"), "utf8"))).toEqual(run.json());
    expect(removal.retries.length).toBeGreaterThan(0);
    for (const retries of removal.retries) {
      expect(retries).toBeGreaterThanOrEqual(5);
    }
    expect(CLEANUP_RETRIES).toBeGreaterThanOrEqual(5);

    const failed = await cli(judging(j, "exit 4"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", exitCode: 4 });
    expect(failed.json()).not.toHaveProperty("cleanup");
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
      complete: true,
      deliveries: [{ sha256: j.sha256, worker: j.worker.address, url: WORK_URL, signature: "first", slot: "5", copies: 1 }],
    });
    expect((await cli(["deliveries", "--attestor", j.worker.address, "--intent", j.intent], {})).json()).toEqual({ intent: j.intent, complete: true, deliveries: [] });
  });

  it("judge refuses an incomplete delivery record", async () => {
    const marker = join(j.dir, "ran");
    const run = `touch "${marker}"`;
    const junk = Array.from({ length: DELIVERY_SCAN }, (_, i): EngineTransaction => ({ signature: `junk${i}`, slot: 20n, blockTime: null, failed: false, emitted: [] }));
    h.engineLog = [...junk, ...h.engineLog];
    for (const more of [[], ["--pay-to", j.worker.address]]) {
      const refused = await cli(judging(j, run, ...more, "--yes"), keys);
      expect(refused.code).toBe(EXIT_FAILED);
      expect(refused.err).toContain("history is too long to read in full");
    }
    expect(existsSync(marker)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect((await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent], {})).json()).toMatchObject({ intent: j.intent, complete: false });
  });

  it("judge reads further with max pages", async () => {
    h.through = flooding(j.judge.address, DELIVERY_PAGES * SIGNATURE_PAGE);
    const marker = join(j.dir, "ran");
    const refused = await cli(judging(j, `touch "${marker}"`), keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`It read ${DELIVERY_PAGES} pages of ${SIGNATURE_PAGE} signatures; a higher --max-pages reads further`);
    expect(existsSync(marker)).toBe(false);
    expect((await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent], {})).json()).toMatchObject({ complete: false });
    const further = String(DELIVERY_PAGES + 1);
    expect((await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent, "--max-pages", further], {})).json()).toMatchObject({
      complete: true,
      deliveries: [{ worker: j.worker.address, signature: "first", copies: 1 }],
    });
    const paid = await cli(judging(j, "true", "--max-pages", further, "--yes"), keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    for (const pages of ["0", "100001", "1.5"]) {
      expect((await cli(judging(j, "true", "--max-pages", pages), keys)).code).toBe(EXIT_USAGE);
    }
  });
});

describe("the artifact hash", () => {
  it("hashes a file by its bytes alone, whatever its name, a directory as a manifest, and refuses links and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-"));
    await writeFile(join(dir, "work.tar"), "bytes");
    await writeFile(join(dir, "renamed"), "bytes");
    expect(await artifactSha256(join(dir, "work.tar"))).toBe(createHash("sha256").update("bytes").digest("hex"));
    expect(await artifactSha256(join(dir, "renamed"))).toBe(await artifactSha256(join(dir, "work.tar")));
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

  it("the kill walk never kills a process that reused the check pid", () => {
    const check = 4000;
    const entry = (pid: number, parent: number, group: number, session: number, started: number): Running => ({ pid, parent, group, session, started, zombie: false });
    const recorded: Recorded = { started: new Map([[check, 100], [4001, 101], [4002, 102]]), retired: new Set() };
    const reuser = [entry(check, 1, check, check, 900), entry(4100, check, check, check, 901), entry(4101, 4100, 4101, check, 902)];
    const ours = [entry(4001, 1, 4001, 4001, 101), entry(4003, 4001, 4001, 4001, 150), entry(4004, 1, 4004, 4001, 160), entry(4005, 1, 4005, 4002, 170)];
    const older = entry(4006, 1, 4006, 4002, 90);
    const pids = (table: Running[]) => claim(table, recorded).map((running) => running.pid);
    expect(pids([...reuser, ...ours, older])).toEqual([4001, 4003, 4004, 4005]);
    expect(recorded.started.has(check)).toBe(false);
    const orphans = [entry(4100, 1, check, check, 901), entry(4101, 1, 4101, check, 902)];
    expect(pids([...orphans, ...ours])).toEqual([4001, 4003, 4004, 4005]);
  });

  it("an escaped process is reported, not ignored", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-escape-"));
    const pidFile = join(dir, "escaped");
    const caught = join(dir, "caught");
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    let escaped = 0;
    let stayed = 0;
    try {
      const run = [
        `sh -c 'echo $$ > "${caught}"; exec sleep 600' &`,
        "sleep 0.1",
        `setsid -f sh -c 'echo $$ > "${pidFile}"; exec sleep 600'`,
        `while ! test -s "${pidFile}"; do sleep 0.01; done`,
      ].join("\n");
      const check = await runCheck(run, checkEnv(process.env, join(dir, SPEC_COPY), dir, "ab"), TIMEOUT_SECONDS * 10, { cwd: dir });
      escaped = Number(await readFile(pidFile, "utf8"));
      stayed = Number(await readFile(caught, "utf8"));
      expect(check).toEqual({ exitCode: 0, timedOut: false, escaped: [escaped] });
      expect(warned.join("")).toContain(leftRunning([escaped]));
      const ended = () => {
        try {
          return readFileSync(`/proc/${stayed}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
        } catch {
          return true;
        }
      };
      await vi.waitFor(() => expect(ended()).toBe(true), { timeout: 5_000 });
    } finally {
      writes.mockRestore();
      for (const pid of [escaped, stayed]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          continue;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const GUIDE = readFileSync(`${ROOT}/docs/judge.md`, "utf8");
const FENCE = "```";
const EXAMPLE_HEADING = "\n## Judge the word count example\n";
const STEPS = GUIDE.slice(0, GUIDE.indexOf(EXAMPLE_HEADING));
const EXAMPLE = GUIDE.slice(GUIDE.indexOf(EXAMPLE_HEADING), GUIDE.indexOf("\n## ", GUIDE.indexOf(EXAMPLE_HEADING) + 1));
const blocks = (language: string, text = STEPS) =>
  text
    .split(`${FENCE}${language}\n`)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(`${FENCE}\n`)));
const guideLines = blocks("sh").flatMap((block) => block.trimEnd().split("\n"));
const words = (line: string, vars: Record<string, string>) =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/\$([A-Z]+)/g, (whole, name: string) => vars[name] ?? whole));

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
    const files: Record<string, string> = { "spec.md": j.spec, work: j.artifact, [`"'$PWD/check.sh'"`]: `'${check}'`, "verdict.json": join(j.dir, "verdict.json") };
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

  it("the judge guide judges the word count example", { timeout: 60_000 }, async () => {
    const example = join(ROOT, "examples/jobs/word-count");
    expect(GUIDE.indexOf(EXAMPLE_HEADING)).toBeGreaterThan(0);
    expect(EXAMPLE).toContain("[`examples/jobs/word-count`](../examples/jobs/word-count)");
    expect(EXAMPLE).toContain("commits `sha256sum examples/jobs/word-count/SPEC.md` as its `specHash`");
    expect(EXAMPLE).toContain("`intent-engine hash --artifact examples/jobs/word-count/delivery`");
    const [tried = "", settled = ""] = blocks("sh", EXAMPLE);
    const local = spawnSync(tried.trim(), { cwd: ROOT, shell: true, encoding: "utf8" });
    expect([local.status, local.stdout.trim()]).toEqual([0, "32 of 32 inputs hold"]);
    expect(EXAMPLE).toContain("prints `32 of 32 inputs hold`");
    const hashed = await cli(["hash", "--artifact", join(example, "delivery")], {});
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
      expect(argv[argv.indexOf("--run") + 1]).toBe(`node '${join(example, "check.mjs")}'`);
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];
    expect(outputs[0]).toMatchObject({ artifactSha256: sha256, exitCode: 0, verdict: "pass", payTo: j.worker.address, signature: null });
    expect(outputs[1]).toMatchObject({ artifactSha256: sha256, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
  });

  it("the judge guide lists every field deliveries prints", async () => {
    const j = await job();
    const printed = (await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent], {})).json();
    const fields = [...Object.keys(printed), ...Object.keys((printed["deliveries"] as Record<string, unknown>[])[0] ?? {})];
    expect(fields.length).toBeGreaterThan(6);
    for (const field of fields) {
      expect(GUIDE).toContain(`\`${field}\``);
    }
  });
});
