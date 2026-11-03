import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { FetchFailed, type SpecFetch } from "@intent-engine/client";
import { parse } from "../src/args.js";
import { DeliveryUnfit, DeliveryUnreadable, fetchBytes, fetchDelivery } from "../src/delivery-fetch.js";
import { judge, type JudgeCommand } from "../src/judge.js";
import { infraSkipped, JudgeInfraError, timedOutInfra } from "../src/judge-errors.js";
import { INFRA_RUNS } from "../src/judge-watch.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { RESAVED } from "../src/resaved.js";
import { keyed } from "./announce.js";
import { h, runtime, transport, world } from "./harness.js";
import { CORRECT, type Job, job, once, paidTo, quietly, run, sha, SPEC, SPEC_URL, status, viperWatch } from "./watch-kit.js";

const dockerWatch = (j: Job, ...more: string[]) => [...once(j), "--sandbox", "docker", "--run", "true", "--yes", "--watch", ...more];

const judgeWith = (command: JudgeCommand, more: { feePayer?: string }) => judge({ ...command, ...more }, runtime({}), transport);

type Fake = { inspect: number; pull: string; run: string };

async function withDocker<T>(fake: Fake, body: (log: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
  const log = join(dir, "calls.log");
  const script = [
    "#!/bin/sh",
    `echo "$1" >> '${log}'`,
    'case "$1" in',
    "  version) echo 27.0.0 ;;",
    `  image) exit ${fake.inspect} ;;`,
    `  pull) ${fake.pull} ;;`,
    `  run) ${fake.run} ;;`,
    "  container) exit 1 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(join(dir, "docker"), script);
  await chmod(join(dir, "docker"), 0o755);
  const saved = process.env["PATH"];
  process.env["PATH"] = [dir, saved ?? ""].join(delimiter);
  try {
    return await body(log);
  } finally {
    process.env["PATH"] = saved;
  }
}

const calls = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((call) => call !== "");

const DOCKER_FAKE = { skip: process.platform === "win32", timeout: 60_000 } as const;

describe("judge --watch on temporary failures", () => {
  it("judges work whose host answered 503 on a later round, and pays it", async () => {
    const j = await job();
    let asked = 0;
    h.specReplies.set(j.url, async () => (++asked === 1 ? new Response("busy", { status: 503 }) : new Response(CORRECT)));
    const watched = await run(viperWatch(j));
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ url: j.url, artifactSha256: null, verdict: "retry", retry: true, reason: `the work at ${j.url} answered 503; it is fetched again later` }),
      expect.objectContaining({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 1 },
    ]);
    expect(asked).toBe(2);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(await paidTo(j)).toBeGreaterThan(0n);
  }, 120_000);

  it("defers a spec url that could not be read once, and pays once it reads", async () => {
    const j = await job({ specUrl: SPEC_URL });
    let asked = 0;
    h.specReplies.set(SPEC_URL, async () => {
      asked += 1;
      if (asked === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response(SPEC);
    });
    const watched = await run(viperWatch(j));
    expect([watched.code, watched.err, asked]).toEqual([EXIT_OK, "", 2]);
    expect(watched.lines).toEqual([
      expect.objectContaining({ artifactSha256: sha(CORRECT), verdict: "retry", retry: true, reason: expect.stringContaining(`who the job ${j.intent} invites cannot be checked`) }),
      expect.objectContaining({ verdict: "pass", payTo: j.worker.address, signature: expect.any(String) }),
      { stopped: "paid", intent: j.intent, judged: 1 },
    ]);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  }, 120_000);

  it("skips a delivery whose check stopped on an infrastructure error INFRA_RUNS times, and says so", DOCKER_FAKE, async () => {
    const j = await job();
    await withDocker({ inspect: 0, pull: "exit 0", run: "exec sleep 30" }, async (log) => {
      const watched = await run(dockerWatch(j, "--timeout", "1"), { rounds: 8 });
      const last = new JudgeInfraError(timedOutInfra(1)).message;
      expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
      expect(watched.lines).toEqual([
        expect.objectContaining({ url: j.url, artifactSha256: sha(CORRECT), verdict: "retry", retry: true, reason: last }),
        { announcement: expect.any(String), seq: "1", worker: j.worker.address, url: j.url, artifactSha256: sha(CORRECT), verdict: "skipped", reason: infraSkipped(INFRA_RUNS, last) },
        { stopped: "ended", intent: j.intent, judged: 0 },
      ]);
      expect((await calls(log)).filter((call) => call === "run")).toHaveLength(INFRA_RUNS);
      expect(watched.slept).toBe(8);
    });
    expect(INFRA_RUNS).toBe(3);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("sends nothing when Ctrl-C arrives while the sandbox image is pulled", DOCKER_FAKE, async () => {
    await quietly(async () => {
      const j = await job();
      await withDocker({ inspect: 1, pull: "sleep 1", run: "exit 0" }, async (log) => {
        const watching = run(dockerWatch(j));
        await vi.waitFor(async () => expect(await calls(log)).toContain("pull"), { timeout: 20_000, interval: 10 });
        process.emit("SIGINT", "SIGINT");
        const watched = await watching;
        expect(watched.code).toBe(130);
        expect(watched.lines).toEqual([{ stopped: "SIGINT", intent: j.intent, judged: 0 }]);
        expect(await calls(log)).not.toContain("run");
      });
      expect(status(j.intent)).toBe(IntentStatus.Open);
      expect(await paidTo(j)).toBe(-1n);
    });
  });
});

describe("the judge's preview and spec check", () => {
  it("previews the release with the fee payer as its payer, so a judge without SOL sees it pass", async () => {
    const j = await job({ broke: true });
    const payer = await keyed("payer.json");
    const command = parse(once(j, "--sandbox", "viper", "--artifact", j.work));
    if (command.name !== "judge") {
      throw new Error(`parsed ${command.name}`);
    }
    const shown = await judgeWith(command, { feePayer: "payer.json" });
    expect(shown).toMatchObject({ verdict: "pass", signature: null, feePayer: payer.address, simulated: { ok: true, units_consumed: expect.any(Number) } });
    const alone = await judgeWith(command, {});
    expect(alone).toMatchObject({ verdict: "pass", signature: null, simulated: { ok: false } });
    expect(alone).not.toHaveProperty("feePayer");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  }, 120_000);

  it("tells a resaved spec file the same way judging once and watching", async () => {
    const j = await job();
    await writeFile(j.spec, `﻿${SPEC.replaceAll("\n", "\r\n")}`);
    const judged = await run([...once(j, "--sandbox", "viper", "--artifact", j.work)]);
    const watched = await run(viperWatch(j));
    for (const refused of [judged, watched]) {
      expect([refused.code, refused.lines]).toEqual([EXIT_FAILED, []]);
      expect(refused.err).toContain(`but intent ${j.intent} commits ${sha(SPEC)}; ${RESAVED}`);
    }
  }, 60_000);
});

const serving =
  (answer: () => Response | Promise<Response>): SpecFetch =>
  async () =>
    answer();

const broken = () =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    },
  });

describe("one rule for work a host could not serve", () => {
  it("calls statuses, resets and timeouts temporary, and other refusals final, for the watch and for MCP alike", async () => {
    await world();
    const url = "https://" + "work.example.org/x";
    const delivery = { announcement: { address: url, intent: url, worker: url, commitment: new Uint8Array(32) } as never, salt: "00".repeat(16), url };
    const failures: [string, SpecFetch, boolean][] = [
      ["503", serving(() => new Response("busy", { status: 503 })), true],
      ["500", serving(() => new Response("oops", { status: 500 })), true],
      ["429", serving(() => new Response("slow down", { status: 429 })), true],
      ["408", serving(() => new Response("late", { status: 408 })), true],
      ["reset", serving(() => Promise.reject(new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }))), true],
      ["timeout", serving(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))), true],
      ["network", serving(() => Promise.reject(new FetchFailed(url, "network", "connect ETIMEDOUT"))), true],
      ["body", serving(() => new Response(broken())), true],
      ["404", serving(() => new Response("gone", { status: 404 })), false],
      ["410", serving(() => new Response("gone", { status: 410 })), false],
      ["redirect", serving(() => Promise.reject(new FetchFailed(url, "redirect", "unexpected redirect"))), false],
      ["fetch redirect", serving(() => Promise.reject(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }))), false],
      ["odd status", serving(() => Promise.reject(new FetchFailed(url, "status", "answered status 999"))), false],
    ];
    for (const [name, get, temporary] of failures) {
      const found = await fetchBytes(get, transport, url);
      expect("problem" in found && found.temporary === true, name).toBe(temporary);
      await expect(fetchDelivery(get, transport, delivery, 5), name).rejects.toBeInstanceOf(temporary ? DeliveryUnreadable : DeliveryUnfit);
    }
  });
});
