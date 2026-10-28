import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { NOBODY_ANNOUNCED } from "../src/announcement-views.js";
import { NOT_SENT } from "../src/flows.js";
import { artifactSha256, EXIT_RETRY, notSent } from "../src/judge.js";
import { INFRA_NEXT, timedOutInfra } from "../src/judge-errors.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, transport } from "./harness.js";
import { gone, job, type Job, judging, paidTo, PROCESS_TEST, PROCESS_WAIT, ROOT, SPEC, STARTUP_SECONDS, status } from "./judge-kit.js";

const timedOut = (seconds: number) => `infrastructure error, not a verdict: ${timedOutInfra(seconds)}; ${INFRA_NEXT}`;

describe("intent-engine judge", () => {
  let j: Job;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    j = await job();
    keys = { "judge.json": j.judge };
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
      [...judging(j, run, "--verdict", verdict).slice(0, 10), join(j.dir, "missing"), ...judging(j, run, "--verdict", verdict).slice(11)],
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
    expect([slow.code, slow.out, slow.err]).toEqual([EXIT_RETRY, "", timedOut(STARTUP_SECONDS)]);
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
    expect([ended.code, ended.out, ended.err]).toEqual([EXIT_RETRY, "", timedOut(STARTUP_SECONDS * 2)]);
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

  it("judge without --yes simulates the release and reports units or the engine error", async () => {
    const passed = await cli(judging(j, "true"), keys);
    expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
    expect(passed.json()).toMatchObject({ verdict: "pass", signature: null, next: NOT_SENT, simulated: { ok: true } });
    const units = (passed.json()["simulated"] as { units_consumed: number }).units_consumed;
    expect(units).toBeGreaterThan(0);
    const failing = await cli(judging(j, "exit 3"), keys);
    expect(failing.json()).toMatchObject({ verdict: "fail", signature: null });
    expect(failing.json()).not.toHaveProperty("simulated");
    const paused = await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "fill"], { "a.json": j.w.authority });
    expect(paused.code).toBe(EXIT_OK);
    const verdict = join(j.dir, "simulated.json");
    const refused = await cli(judging(j, "true", "--verdict", verdict), keys);
    expect([refused.code, refused.err]).toEqual([EXIT_OK, ""]);
    expect(refused.json()).toMatchObject({ verdict: "pass", signature: null, simulated: { ok: false, error: "FillPaused" } });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(refused.json());
    expect(status(j.intent)).toBe(IntentStatus.Open);
    expect(await paidTo(j, j.worker.address)).toBe(-1n);
  });

  it("fails, sends nothing and exits non-zero when the check exits non-zero", async () => {
    const failed = await cli(judging(j, "exit 3", "--yes"), keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ exitCode: 3, verdict: "fail", payTo: j.worker.address, signature: null });
    expect(failed.json()).not.toHaveProperty("next");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("stops a check that outlives --timeout, kills its whole process tree, and reports it as an infrastructure error", PROCESS_TEST, async () => {
    const pid = join(j.dir, "pid");
    const slow = await cli(judging(j, `sleep 600 & echo $! > "${pid}"; wait`, "--timeout", String(STARTUP_SECONDS), "--yes"), keys);
    expect([slow.code, slow.out, slow.err]).toEqual([EXIT_RETRY, "", timedOut(STARTUP_SECONDS)]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const child = Number(await readFile(pid, "utf8"));
    expect(await gone(child)).toBe(true);
  });

  it("refuses before running anything when the spec differs from the committed hash, nobody announced the artifact, or the keypair is not the judge", async () => {
    const marker = join(j.dir, "ran");
    const run = `touch "${marker}"`;
    await writeFile(join(j.dir, "other.md"), "a different spec\n");
    const mismatch = await cli([...judging(j, run).slice(0, 7), "--spec", join(j.dir, "other.md"), ...judging(j, run).slice(9)], keys);
    expect(mismatch.code).toBe(EXIT_FAILED);
    expect(mismatch.err).toContain(`but intent ${j.intent} commits ${createHash("sha256").update(SPEC).digest("hex")}`);

    const stranger = await funded();
    const foreign = await cli(judging(j, run), { "judge.json": stranger });
    expect(foreign.err).toContain(`names ${j.judge.address} as its judge, not ${stranger.address}`);

    await writeFile(join(j.artifact, "extra.txt"), "unannounced\n");
    const nobody = await cli(judging(j, run, "--yes"), keys);
    expect(nobody.code).toBe(EXIT_FAILED);
    expect(nobody.err).toContain(`has no announcement that opens to the work ${await artifactSha256(j.artifact)}`);
    expect(existsSync(marker)).toBe(false);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    await rm(join(j.artifact, "extra.txt"));

    const paid = await cli(judging(j, "true", "--yes"), keys);
    expect(paid.json()).toMatchObject({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(await paidTo(j, j.copier.address)).toBe(-1n);
    const closed = await cli(judging(j, run), keys);
    expect(closed.err).toContain(`intent ${j.intent} is no longer open`);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an escrow nobody announced to, saying so", async () => {
    const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: j.judge.address, specHash, judgeFee: 0n } as const;
    await createClient({ url: "http://cluster", transport }).createIntent({ signer: j.w.owner, params, inputMint: j.w.inputMint, outputMint: j.w.outputMint, nonce: 3n, expiresAt: NOW + 3_600n });
    const args = judging(j, "true", "--yes");
    args[args.indexOf("--nonce") + 1] = "3";
    const refused = await cli(args, keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(NOBODY_ANNOUNCED);
  });
});
