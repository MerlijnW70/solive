import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none, type Signature } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEvent, deliveryMemo, DEVNET_TEST_MINT, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, manifestSha256, NATIVE_MINT, RELEASE_MEMO_PREFIX, releaseMemo } from "@intent-engine/core";
import { createClient, DELIVERY_PAGES, DELIVERY_SCAN, type EngineTransaction, type ListedSignature, SIGNATURE_PAGE, type Transport } from "@intent-engine/client";
import { ENV_KEYPAIR, JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, RUN_NEEDED } from "../src/args.js";
import { ATTEST_PAGES } from "../src/agent/wallet/delivery.js";
import { MAX_DELIVERY_PAGES } from "../src/command-builders.js";
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
  notSent,
  type Recorded,
  removeCopy,
  resultOutside,
  runCheck,
  type Running,
  SKIPPED,
  SPEC_COPY,
} from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { copyOf, readArtifact } from "../src/artifact.js";
import { runContainer } from "../src/check-process.js";
import {
  containerArgs,
  CPUS_FORMAT,
  dockerEnv,
  IMAGE_NEEDS_DIGEST,
  MEMORY_FORMAT,
  NO_SANDBOX,
  SANDBOX_IMAGE,
  SANDBOX_NEEDED,
  sandboxOnly,
  shareable,
} from "../src/sandbox.js";
import { ata, balance, cli, creation, funded, h, NOW, send, transport, type World, world } from "./harness.js";

const removal = vi.hoisted(() => ({ refused: false, retries: [] as (number | undefined)[] }));
const writing = vi.hoisted(() => ({ before: null as ((path: string) => Promise<void>) | null }));
const proc = vi.hoisted(() => ({ hidden: false }));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (proc.hidden && String(args[0]) === "/proc") {
        throw Object.assign(new Error("ENOENT: no such file or directory, scandir '/proc'"), { code: "ENOENT" });
      }
      return actual.readdir(...args);
    }) as typeof actual.readdir,
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
const STARTUP_SECONDS = 3;

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

const judging = (j: Job, run: string, ...more: string[]) => [...boxed(j, run, ...more), "--sandbox", "none"];

const boxed = (j: Job, run: string, ...more: string[]) => [
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

const PROCESS_WAIT = { timeout: 20_000, interval: 20 } as const;

const PROCESS_TEST = { timeout: 30_000 } as const;

const signalled = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const alive = (pid: number) => {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return process.platform !== "linux" && signalled(pid);
  }
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
};

const gone = async (pid: number) => {
  try {
    await vi.waitFor(() => expect(alive(pid)).toBe(false), PROCESS_WAIT);
  } catch {
    return false;
  }
  return true;
};

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
      sandbox: "none",
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

  it("an interrupted check never passes", PROCESS_TEST, async () => {
    const started = join(j.dir, "started");
    const root = join(j.dir, "root");
    const verdict = join(j.dir, "interrupted.json");
    const run = `pwd > "${root}"; touch "${started}"; trap 'exit 0' INT TERM; sleep 600; exit 0`;
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      await rm(started, { force: true });
      const others = process.listeners(signal);
      process.removeAllListeners(signal);
      try {
        const running = cli(judging(j, run, "--verdict", verdict, "--yes"), keys);
        await vi.waitFor(() => expect(existsSync(started)).toBe(true), PROCESS_WAIT);
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

  it("a second interrupt during settlement still reports the signature", PROCESS_TEST, async () => {
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
      await vi.waitFor(() => expect(exits).toHaveBeenCalledWith(130), PROCESS_WAIT);

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

  it("an interrupt before sending pays nothing", PROCESS_TEST, async () => {
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
        await vi.waitFor(() => expect(attempts).toHaveLength(1), PROCESS_WAIT);
      } finally {
        h.through = null;
        for (const listener of others) {
          process.on(signal, listener as NodeJS.SignalsListener);
        }
      }
      expect(existsSync(verdict)).toBe(false);
      expect(status(run.intent)).toBe(IntentStatus.Open);
      expect(await paidTo(run, run.worker.address)).toBe(-1n);
      expect(attempts).toEqual([expect.stringContaining(notSent(signal))]);
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

  it("a judge timeout also kills a delivery in its own process group", PROCESS_TEST, async () => {
    const grouped = join(j.dir, "grouped");
    const own = `perl -e 'setpgrp(0, 0); open(my $f, ">", $ARGV[0]) or die; print $f "$$ " . getpgrp(); close $f; exec "sleep", "600"' "${grouped}" & wait`;
    const slow = await cli(judging(j, own, "--timeout", String(STARTUP_SECONDS), "--yes"), keys);
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
    const ended = await cli(judging({ ...loop, artifact: looping }, `node '${join(example, "check.mjs")}'`, "--timeout", String(STARTUP_SECONDS * 2), "--yes"), { "judge.json": loop.judge });
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

  it("a stale verdict file is removed before the check", PROCESS_TEST, async () => {
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
      const running = cli(judging(j, `touch "${started}"; sleep 600; exit 0`, "--verdict", verdict, "--yes"), keys);
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), PROCESS_WAIT);
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

  it("fails a check that outlives --timeout and kills its whole process tree", PROCESS_TEST, async () => {
    const pid = join(j.dir, "pid");
    const slow = await cli(judging(j, `sleep 600 & echo $! > "${pid}"; wait`, "--timeout", String(STARTUP_SECONDS), "--yes"), keys);
    expect(slow.code).toBe(EXIT_FAILED);
    expect(slow.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null });
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const child = Number(await readFile(pid, "utf8"));
    expect(await gone(child)).toBe(true);
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

const DOCKER = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0 || process.env["CI"] !== undefined;

const DOCKER_TEST = { skip: !DOCKER, timeout: 120_000 } as const;

const containerGone = (name: string) => spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status !== 0;

describe("the judge sandbox", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
  });

  it("a sandboxed check has no network", DOCKER_TEST, async () => {
    const reach = `node -e 'const s = require("net").connect(53, "1.1.1.1"); s.on("connect", () => process.exit(1)); s.on("error", () => process.exit(0)); setTimeout(() => process.exit(0), 5000)'`;
    const check = [`test "$(ls /sys/class/net)" = lo`, reach, `! getent hosts example.org`].join(" && ");
    const run = await cli(boxed(j, check), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE, exitCode: 0 });
    const leak = await cli(boxed(j, `node -e 'require("net").connect(53, "1.1.1.1").on("connect", () => process.exit(0)).on("error", () => process.exit(7))'`), keys);
    expect(leak.json()).toMatchObject({ verdict: "fail", exitCode: 7, signature: null });
  });

  it("a sandboxed check cannot read the judge keypair or home", DOCKER_TEST, async () => {
    const home = await mkdtemp(join(tmpdir(), "judge-home-"));
    const keypair = join(home, "judge.json");
    await writeFile(keypair, "[1,2,3]");
    const check = [
      `test ! -e "${keypair}"`,
      `test ! -e "${home}"`,
      `test ! -e "${j.dir}"`,
      `test ! -e "${homedir()}"`,
      "test ! -e /var/run/docker.sock",
      "test ! -e /run/docker.sock",
      'test "$HOME" = /tmp',
      'test "$(id -u)" = 65534',
      '! grep -rqs "1,2,3" /tmp /judge/work /judge/spec',
    ].join(" && ");
    try {
      process.env[ENV_KEYPAIR] = keypair;
      const run = await cli(boxed(j, check, "--verdict", join(j.dir, "verdict.json")), keys);
      expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
      expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE });
      const reading = await cli(boxed(j, `cat "${keypair}"`), keys);
      expect(reading.json()).toMatchObject({ verdict: "fail", signature: null });
    } finally {
      delete process.env[ENV_KEYPAIR];
    }
    const unboxed = await cli(judging(j, `test "$(cat "${keypair}")" = "[1,2,3]"`), keys);
    expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none" });
    expect(unboxed.json()).not.toHaveProperty("image");
  });

  it("a sandboxed check sees only the read only artifact and spec", DOCKER_TEST, async () => {
    const check = [
      `test "$ARTIFACT_PATH" = /judge/work`,
      `test "$SPEC_PATH" = /judge/spec/${SPEC_COPY}`,
      `test "$ARTIFACT_SHA256" = ${j.sha256}`,
      'test "$(pwd)" = /judge',
      'test "$(ls /judge | tr "\\n" " ")" = "spec work "',
      'test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42',
      'test "$(cat "$ARTIFACT_PATH/src/notes.txt")" = how',
      'test "$(find /judge -type f | wc -l)" -eq 3',
      'test "$(cat "$SPEC_PATH")" = "answer.txt holds 42"',
      '! touch "$ARTIFACT_PATH/answer.txt" 2> /dev/null',
      '! touch "$ARTIFACT_PATH/new" 2> /dev/null',
      '! touch "$SPEC_PATH" 2> /dev/null',
      "! touch /judge/new 2> /dev/null",
      "! touch /etc/new 2> /dev/null",
      "echo scratch > /tmp/scratch",
      "test \"$(cat /tmp/scratch)\" = scratch",
      'test "$(cat /sys/fs/cgroup/pids.max)" = 256',
      'test "$(cat /sys/fs/cgroup/memory.max)" = 536870912',
      'test "$(cut -d " " -f 1 /sys/fs/cgroup/cpu.max)" = 50000',
      'test "$(grep CapEff /proc/self/status | cut -f 2)" = 0000000000000000',
    ].join(" && ");
    const run = await cli(boxed(j, check, "--sandbox-memory", "512m", "--sandbox-cpus", "0.5"), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", sandbox: "docker", image: SANDBOX_IMAGE, artifactSha256: j.sha256 });
    expect(await readFile(join(j.artifact, "answer.txt"), "utf8")).toBe("42\n");
    expect(await readFile(j.spec, "utf8")).toBe(SPEC);
    for (const [option, value, refusal] of [
      ["--sandbox-memory", "lots", MEMORY_FORMAT],
      ["--sandbox-cpus", "0", CPUS_FORMAT],
      ["--sandbox", "vm", SANDBOX_NEEDED],
    ] as const) {
      expect(await cli(boxed(j, "true", option, value), keys)).toMatchObject({ code: EXIT_USAGE, err: refusal });
    }
  });

  it("a sandboxed check is stopped and removed on timeout", DOCKER_TEST, async () => {
    const slow = await cli(boxed(j, "sleep 600", "--timeout", String(STARTUP_SECONDS), "--yes"), keys);
    expect(slow.code).toBe(EXIT_FAILED);
    expect(slow.json()).toMatchObject({ exitCode: null, verdict: "fail", signature: null, sandbox: "docker" });
    expect(status(j.intent)).toBe(IntentStatus.Open);

    const copy = await copyOf(await readArtifact(j.artifact), new TextEncoder().encode(SPEC));
    const name = `judge-test-${process.pid}-${Date.now()}`;
    const sandbox = { kind: "docker", image: SANDBOX_IMAGE, memory: "256m", cpus: "1" } as const;
    try {
      await shareable(copy.root);
      const started = Date.now();
      const check = await runContainer(containerArgs(sandbox, copy, j.sha256, "sleep 600"), name, dockerEnv(process.env), STARTUP_SECONDS);
      expect(check).toEqual({ exitCode: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(containerGone(name)).toBe(true);
      const quick = `${name}-quick`;
      expect(await runContainer(containerArgs(sandbox, copy, j.sha256, "exit 3"), quick, dockerEnv(process.env), STARTUP_SECONDS * 10)).toEqual({ exitCode: 3, timedOut: false });
      expect(containerGone(quick)).toBe(true);
    } finally {
      spawnSync("docker", ["rm", "-f", name, `${name}-quick`], { stdio: "ignore" });
      await removeCopy(copy.root);
    }
  });

  it("an image without a digest is refused", async () => {
    const marker = join(j.dir, "ran");
    for (const image of ["node:22-bookworm-slim", "node@sha256:abc", "node:22@sha512:" + "a".repeat(64)]) {
      const refused = await cli(boxed(j, `touch "${marker}"`, "--sandbox-image", image, "--yes"), keys);
      expect([refused.code, refused.err, refused.out]).toEqual([EXIT_USAGE, IMAGE_NEEDS_DIGEST, ""]);
    }
    const mixed = await cli(judging(j, `touch "${marker}"`, "--sandbox-image", SANDBOX_IMAGE), keys);
    expect([mixed.code, mixed.err]).toEqual([EXIT_USAGE, sandboxOnly("sandbox-image")]);
    expect(existsSync(marker)).toBe(false);
    expect(SANDBOX_IMAGE).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/);
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci.slice(ci.indexOf("  check:"), ci.indexOf("  node-floor:"))).toContain(`run: docker pull ${SANDBOX_IMAGE}\n`);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("without docker the judge refuses unless sandbox none", async () => {
    const empty = await mkdtemp(join(tmpdir(), "judge-no-docker-"));
    const marker = join(j.dir, "ran");
    const verdict = join(j.dir, "verdict.json");
    const saved = process.env["PATH"];
    process.env["PATH"] = empty;
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    try {
      await writeFile(verdict, "stale");
      const refused = await cli(boxed(j, `: > "${marker}"`, "--verdict", verdict, "--yes"), keys);
      expect([refused.code, refused.out]).toEqual([EXIT_FAILED, ""]);
      expect(refused.err).toContain("docker is not available");
      expect(refused.err).toContain("install Docker from https://docs.docker.com/engine/install/");
      expect(refused.err).toContain("or pass --sandbox none");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(verdict)).toBe(false);
      expect(status(j.intent)).toBe(IntentStatus.Open);
      expect(warned.join("")).not.toContain(NO_SANDBOX);
      const unboxed = await cli(judging(j, `: > "${marker}"`, "--verdict", verdict), keys);
      expect([unboxed.code, unboxed.err]).toEqual([EXIT_OK, ""]);
      expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none", exitCode: 0 });
      expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(unboxed.json());
      expect(existsSync(marker)).toBe(true);
      expect(warned.join("")).toContain(NO_SANDBOX);
    } finally {
      process.env["PATH"] = saved;
      writes.mockRestore();
    }
  });

  it("the word count example passes inside the sandbox", DOCKER_TEST, async () => {
    const example = join(ROOT, "examples/jobs/word-count");
    const delivery = join(example, "delivery/wordcount.mjs");
    const counted = await job(await readFile(join(example, "SPEC.md"), "utf8"), await artifactSha256(delivery));
    const keysOf = { "judge.json": counted.judge };
    const checkArgs = ["--check", join(example, "check.mjs")];
    const preview = await cli(boxed({ ...counted, artifact: delivery }, "node check/check.mjs", ...checkArgs), keysOf);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ verdict: "pass", exitCode: 0, sandbox: "docker", image: SANDBOX_IMAGE, signature: null });
    const paid = await cli(boxed({ ...counted, artifact: delivery }, "node check/check.mjs", ...checkArgs, "--yes"), keysOf);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ verdict: "pass", sandbox: "docker", payTo: counted.worker.address, signature: expect.any(String) });
    expect(await paidTo(counted, counted.worker.address)).toBeGreaterThan(0n);

    const thief = await mkdtemp(join(tmpdir(), "judge-thief-"));
    const secret = join(tmpdir(), `judge-secret-${process.pid}.json`);
    await writeFile(secret, "[9,9,9]");
    await writeFile(
      join(thief, "wordcount.mjs"),
      `import { readFileSync } from "node:fs";\nlet stolen = "";\ntry {\n  stolen = readFileSync(${JSON.stringify(secret)}, "utf8");\n} catch {}\nexport default function count(text) {\n  return stolen === "" ? -1 : (text.match(/\\S+/g) ?? []).length;\n}\n`,
    );
    const stolen = await job(await readFile(join(example, "SPEC.md"), "utf8"), await artifactSha256(thief));
    const refused = await cli(boxed({ ...stolen, artifact: thief }, "node check/check.mjs", ...checkArgs, "--yes"), { "judge.json": stolen.judge });
    expect(refused.json()).toMatchObject({ verdict: "fail", exitCode: 1, sandbox: "docker", signature: null });
    expect(status(stolen.intent)).toBe(IntentStatus.Open);
    const unboxed = await cli(judging({ ...stolen, artifact: thief }, "node check/check.mjs", ...checkArgs), { "judge.json": stolen.judge });
    expect(unboxed.json()).toMatchObject({ verdict: "pass", sandbox: "none" });
    await rm(secret, { force: true });
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
    const recorded: Recorded = { started: new Map([[check, 100], [4001, 101], [4002, 102]]), leaders: new Map([[check, 100], [4001, 101], [4002, 102]]) };
    const reuser = [entry(check, 1, check, check, 900), entry(4100, check, check, check, 901), entry(4101, 4100, 4101, check, 902)];
    const ours = [entry(4001, 1, 4001, 4001, 101), entry(4003, 4001, 4001, 4001, 150), entry(4004, 1, 4004, 4001, 160), entry(4005, 1, 4005, 4002, 170)];
    const older = entry(4006, 1, 4006, 4002, 90);
    const pids = (table: Running[]) => claim(table, recorded).map((running) => running.pid);
    expect(pids([...reuser, ...ours, older])).toEqual([4001, 4003, 4004, 4005]);
    expect(recorded.started.has(check)).toBe(false);
    const orphans = [entry(4100, 1, check, check, 901), entry(4101, 1, 4101, check, 902)];
    expect(pids([...orphans, ...ours])).toEqual([4001, 4003, 4004, 4005]);
  });

  it("a reused pid that was never a session leader of the check is not killed", () => {
    const check = 5000;
    const entry = (pid: number, parent: number, group: number, session: number, started: number): Running => ({ pid, parent, group, session, started, zombie: false });
    const recorded: Recorded = { started: new Map([[check, 100]]), leaders: new Map([[check, 100]]) };
    const pids = (table: Running[]) => claim(table, recorded).map((running) => running.pid);
    expect(pids([entry(check, 1, check, check, 100), entry(5001, check, check, check, 110)])).toEqual([check, 5001]);
    expect([...recorded.leaders.keys()]).toEqual([check]);
    const daemon = entry(5100, 1, 5100, 5001, 400);
    const grandchild = entry(5101, 5100, 5100, 5001, 410);
    expect(pids([entry(check, 1, check, check, 100), daemon, grandchild])).toEqual([check]);
    const leftover = entry(5200, 1, 5200, check, 300);
    expect(pids([leftover, daemon, grandchild])).toEqual([5200]);
  });

  it("without proc leftovers after exit are reported", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-noproc-"));
    const pidFile = join(dir, "left");
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    let left = 0;
    proc.hidden = true;
    try {
      const check = await runCheck(`sleep 600 > /dev/null 2>&1 &\necho $! > "${pidFile}"\nexit 0`, process.env, TIMEOUT_SECONDS * 10, { cwd: dir });
      left = Number(await readFile(pidFile, "utf8"));
      expect(check).toEqual({ exitCode: 0, timedOut: false, escaped: [left] });
      expect(warned.join("")).toContain(leftRunning([left]));
      expect(() => process.kill(left, 0)).not.toThrow();
    } finally {
      proc.hidden = false;
      writes.mockRestore();
      if (left > 0) {
        spawnSync("kill", ["-KILL", String(left)]);
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an escaped process is reported, not ignored", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "judge-escape-"));
    const caught = join(dir, "caught");
    const go = join(dir, "go");
    const warned: string[] = [];
    const writes = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warned.push(String(text));
      return true;
    });
    let escaped = 0;
    let stayed = 0;
    try {
      const run = [`sh -c 'echo $$ > "${caught}.tmp"; mv "${caught}.tmp" "${caught}"; exec sleep 600' &`, `while ! test -e "${go}"; do sleep 0.01; done`].join("\n");
      const env = checkEnv(process.env, join(dir, SPEC_COPY), dir, "ab");
      const checking = runCheck(run, env, STARTUP_SECONDS * 20, { cwd: dir });
      await vi.waitFor(() => expect(existsSync(caught)).toBe(true), PROCESS_WAIT);
      const outside = spawn("sleep", ["600"], { env, cwd: dir, detached: true, stdio: "ignore" });
      outside.unref();
      escaped = outside.pid ?? 0;
      expect(escaped).toBeGreaterThan(0);
      await vi.waitFor(() => expect(readFileSync(`/proc/${escaped}/environ`, "utf8").split("\0")).toContain(`${ENV_SPEC_PATH}=${env[ENV_SPEC_PATH]}`), PROCESS_WAIT);
      await writeFile(go, "");
      const check = await checking;
      stayed = Number(await readFile(caught, "utf8"));
      expect(check).toEqual({ exitCode: 0, timedOut: false, escaped: [escaped] });
      expect(warned.join("")).toContain(leftRunning([escaped]));
      await vi.waitFor(() => expect(alive(stayed)).toBe(false), PROCESS_WAIT);
      expect(alive(escaped)).toBe(true);
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
  it("finds, checks and settles a proof escrow with exactly the commands it prints", async () => {
    const j = await job();
    const commands = guideLines.filter((l) => l.startsWith("intent-engine "));
    const setup = guideLines.filter((l) => !l.startsWith("intent-engine "));
    expect(setup.slice(2)).toEqual(['curl -fsSL -o spec.md "$SPEC_URL"']);
    expect(setup[0]).toBe("export SPEC_URL=https://example.org/spec.md");
    expect(setup[1]).toMatch(HASH_LINE);
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
    const vars = { PWD: j.dir, INTENT: j.intent, OWNER: j.w.owner.address, NONCE: "0" };
    const files: Record<string, string> = { "spec.md": j.spec, work: j.artifact, "verdict.json": join(j.dir, "verdict.json"), "check.mjs": check };
    const viaBash = await cli(boxed(j, "bash check/check.sh", "--check", bashCheck), { "judge.json": j.judge });
    expect(viaBash.json()).toMatchObject({ verdict: "pass", exitCode: 0, signature: null, sandbox: "docker", image: SANDBOX_IMAGE });
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands.slice(1)) {
      const argv = words(line.replaceAll("$(solana address)", j.judge.address), vars)
        .slice(1)
        .map((arg) => files[arg] ?? arg);
      const run = await cli(argv, { "judge.json": j.judge });
      expect([run.code, run.err], line).toEqual([EXIT_OK, ""]);
      outputs.push(run.json());
    }
    delete h.env[ENV_KEYPAIR];

    expect(GUIDE).toContain("pass `--check check.sh --run \"bash check/check.sh\"` in place of the `--check` and `--run` of step 5");
    expect(outputs[0]).toMatchObject({ jobs: [{ intent: j.intent, owner: j.w.owner.address, nonce: "0", specUrl: null }] });
    expect(outputs[1]).toMatchObject({ deliveries: [{ sha256: j.sha256, worker: j.worker.address, copies: 1 }] });
    expect(outputs[2]).toMatchObject({ verdict: "pass", command: "node check/check.mjs", sandbox: "docker", payTo: j.worker.address, signature: null });
    expect(outputs[3]).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    expect(GUIDE).toContain(`at most \`--timeout\` seconds (default ${JUDGE_TIMEOUT}, at most ${MAX_JUDGE_TIMEOUT})`);
    expect(GUIDE).toContain("skipping `.git`, `node_modules` and `target`");
    expect([...SKIPPED]).toEqual([".git", "node_modules", "target"]);
    expect(GUIDE).toContain(
      `gives it three environment variables: \`${ENV_SPEC_PATH}\`, the spec file; \`${ENV_ARTIFACT_PATH}\`, the work; \`${ENV_ARTIFACT_SHA256}\`, the work's hash.`,
    );
    expect(GUIDE).toContain(`records the memo \`${RELEASE_MEMO_PREFIX}<artifactSha256>\``);
    expect(GUIDE).toContain("Do steps 1 to 4 of the [quickstart](quickstart.md) first");
    expect(GUIDE).toContain(`by default \`${SANDBOX_IMAGE}\`, which holds Node.js 22`);
    expect(GUIDE).toContain("`--sandbox none` runs the check without a container");
    expect(GUIDE).not.toContain("sha256sum");
  });

  it("the judge guide creates the escrow it judges", async () => {
    const w = await world();
    const reader = await funded();
    const worker = await generateKeyPairSigner();
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
    expect(createLine).toContain(" --attestor $(solana address) --spec-hash $SPEC_HASH --judge-fee 0.001 --spec-url $SPEC_URL ");
    expect(linesOf("powershell", created)).toEqual([`$env:SPEC_URL = "${specUrl}"`, POWERSHELL_HASH("spec.md"), toPowerShell(createLine)]);

    h.watched.push(reader.address);
    h.env[ENV_KEYPAIR] = "judge.json";
    const keys = { "judge.json": reader };
    const argv = createLine.replaceAll("$(solana address)", reader.address).replace("$SPEC_HASH", specHash).replace("$SPEC_URL", specUrl).split(" ").slice(1);
    const made = await cli(argv, keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    expect(balance(wrapped)).toBe(200_000_000n - 10_000_000n);

    const [jobsLine = ""] = linesOf("sh", section("2. Find the job")).filter((l) => l.startsWith("intent-engine jobs "));
    const listed = await cli(jobsLine.replace("$(solana address)", reader.address).split(" ").slice(1), keys);
    const [found] = (listed.json()["jobs"] ?? []) as { intent: Address; owner: string; nonce: string; specHash: string }[];
    expect(found).toMatchObject({ owner: reader.address, specHash });
    const intent = found?.intent ?? reader.address;
    const params = h.svm.getAccount(intent);
    expect(params.exists).toBe(true);

    const sha256 = await artifactSha256(work);
    h.engineLog = [announced(intent, worker.address, sha256, "first", 5n), creation(intent)];
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

  it("the judge guide judges the word count example", async () => {
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
    const printed = (await cli(["deliveries", "--attestor", j.judge.address, "--intent", j.intent], {})).json();
    const fields = [...Object.keys(printed), ...Object.keys((printed["deliveries"] as Record<string, unknown>[])[0] ?? {})];
    expect(fields.length).toBeGreaterThan(6);
    for (const field of fields) {
      expect(GUIDE).toContain(`\`${field}\``);
    }
  });

  it("the judge guide states the page defaults of the CLI and the MCP tools", () => {
    expect(DELIVERY_PAGES).toBe(100);
    expect(ATTEST_PAGES).toBe(1_000);
    expect(GUIDE).toContain(
      `\`judge\` and \`deliveries\` read ${DELIVERY_PAGES} pages by default, while the MCP tools \`solive_wallet_attest\` and \`solive_wallet_attest_split\` read up to their \`max_pages\`, default ${ATTEST_PAGES};`,
    );
    expect(GUIDE).toContain(`pages of ${SIGNATURE_PAGE} transactions (default ${DELIVERY_PAGES}, at most ${MAX_DELIVERY_PAGES})`);
  });
});
