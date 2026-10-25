import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { ENV_KEYPAIR } from "../src/args.js";
import { NOT_SENT } from "../src/flows.js";
import { resultOutside } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced as announce } from "./announce.js";
import { cli, h, NOW, transport } from "./harness.js";
import { job, type Job, judging, paidAnnouncement, paidTo, PROCESS_TEST, PROCESS_WAIT, releasedIn, SPEC, status, WORK_URL } from "./judge-kit.js";

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
      announcement: j.first.announcement,
      seq: "1",
      salt: j.first.salt,
      signature: null,
    };
    expect(preview.json()).toEqual({ ...shown, simulated: { ok: true, units_consumed: expect.any(Number) }, next: NOT_SENT });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(preview.json());
    expect(await paidTo(j, j.worker.address)).toBe(-1n);

    const sent = await cli(judging(j, check, "--verdict", verdict, "--yes"), keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toEqual({ ...shown, signature: expect.any(String) });
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(sent.json());
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
    expect(await paidTo(j, j.copier.address)).toBe(-1n);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(paidAnnouncement(sent.json()["signature"])).toBe(j.first.announcement);
  });

  it("judge refuses a result outside the escrow bounds before running the check", async () => {
    const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 5n, attestor: j.judge.address, specHash, judgeFee: 0n } as const;
    const client = createClient({ url: "http://cluster", transport });
    const { intent } = await client.createIntent({ signer: j.w.owner, params, inputMint: j.w.inputMint, outputMint: j.w.outputMint, nonce: 1n, expiresAt: NOW + 3_600n });
    const made = await announce(intent, j.worker, j.sha256, WORK_URL);
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
    expect(paidAnnouncement(paid.json()["signature"])).toBe(made.announcement);
    expect(await paidTo(j, j.worker.address)).toBeGreaterThan(0n);
  });

  it("judge settles with the given result", async () => {
    const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 2n, maxResult: 5n, attestor: j.judge.address, specHash, judgeFee: 0n } as const;
    const client = createClient({ url: "http://cluster", transport });
    const { intent } = await client.createIntent({ signer: j.w.owner, params, inputMint: j.w.inputMint, outputMint: j.w.outputMint, nonce: 2n, expiresAt: NOW + 3_600n });
    await announce(intent, j.worker, j.sha256, WORK_URL);
    const verdict = join(j.dir, "result.json");
    const args = judging(j, "true", "--result", "4", "--verdict", verdict, "--yes");
    args[args.indexOf("--nonce") + 1] = "2";
    const paid = await cli(args, keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(paid.json()).toMatchObject({ intent, verdict: "pass", payTo: j.worker.address, signature: expect.any(String) });
    expect(paid.json()).not.toHaveProperty("next");
    expect(JSON.parse(await readFile(verdict, "utf8"))).toEqual(paid.json());
    expect(status(intent)).toBe(IntentStatus.Filled);
    const attested = releasedIn(paid.json()["signature"]).find((event) => event.name === "IntentAttested");
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
});
