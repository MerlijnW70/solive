import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { deliveryBookAddress, getIntentDecoder } from "@intent-engine/core/internal";
import { boundMembers } from "@intent-engine/client/internal";
import { createClient } from "@intent-engine/client/node";
import { NOBODY_ANNOUNCED } from "../src/announcement-views.js";
import { parse } from "../src/args.js";
import { deliveryBookPath } from "../src/delivery-record.js";
import { EXIT_REFUSED, EXIT_RETRY } from "../src/judge-errors.js";
import { WATCH_TAKES_NO_WAIT } from "../src/job-args.js";
import { ANNOUNCE_WAIT, ownPending, waitedFor } from "../src/judge-wait.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { announced, keyed, WORK_URL } from "./announce.js";
import { cli, h, HOME, NOW, transport, type World, world } from "./harness.js";

const SPEC = "answer.txt holds 42\n";
const CHECK = `test "$(cat "$ARTIFACT_PATH")" = 42`;

type Job = { w: World; judge: KeyPairSigner; intent: Address; spec: string; artifact: string; sha256: string; keys: Record<string, KeyPairSigner> };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "announce-wait-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "answer.txt");
  await writeFile(spec, SPEC);
  await writeFile(artifact, "42\n");
  const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  return { w, judge, intent, spec, artifact, sha256: createHash("sha256").update("42\n").digest("hex"), keys: { "judge.json": judge } };
}

const judging = (j: Job, ...more: string[]) => [
  "judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--run", CHECK, "--sandbox", "none", "--i-trust-this-work", ...more,
];

const status = (intent: Address) => {
  const held = h.svm.getAccount(intent);
  return held.exists ? getIntentDecoder().decode(held.data).status : undefined;
};

describe("judge waits for a fresh announcement instead of racing it", () => {
  let j: Job;

  beforeEach(async () => {
    j = await job();
    h.rounds = 100;
  });

  it("waits while the node does not show the work's announcement yet and pays once it does", async () => {
    const worker = await keyed("worker.json");
    const made = await announced(j.intent, worker, j.sha256);
    const hidden = new Set<Address>([made.announcement, await deliveryBookAddress(j.intent)]);
    const inner = boundMembers(transport);
    h.through = {
      ...inner,
      getAccount: async (address) => (hidden.has(address) ? null : inner.getAccount(address)),
      getAccounts: async (addresses) => Promise.all(addresses.map((address) => (hidden.has(address) ? null : inner.getAccount(address)))),
      engineAccounts: async (filter) => (await (inner.engineAccounts?.(filter) ?? [])).filter(({ address }) => !hidden.has(address)),
    };
    h.onSleep.push(() => undefined, () => hidden.clear());
    const run = await cli(judging(j, "--announce-wait", "10", "--yes"), j.keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", payTo: worker.address });
    expect(h.sleeps).toEqual([2, 2]);
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });

  it("refuses after the bounded wait and names it", async () => {
    const none = await cli(judging(j, "--announce-wait", "5", "--yes"), j.keys);
    expect(none.code).toBe(EXIT_REFUSED);
    expect(none.err).toContain(NOBODY_ANNOUNCED);
    expect(none.err).toContain(waitedFor(5));
    expect(h.sleeps).toEqual([2, 2, 1]);
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("never says nobody announced while this machine's own confirmed deliver is not listed yet", async () => {
    const worker = await keyed("worker.json");
    const plan = await createClient({ url: "http://cluster", transport }).plan.announce({ worker, intent: j.intent, sha256: j.sha256, url: WORK_URL });
    const own = { intent: j.intent, sha256: j.sha256, announcement: plan.announcement, seq: "1", signature: "5".repeat(88), slot: "9", worker: worker.address };
    h.files.set(deliveryBookPath(HOME, j.intent), JSON.stringify([own]));
    const pending = await cli(judging(j, "--announce-wait", "4", "--yes"), j.keys);
    expect(pending.code).toBe(EXIT_RETRY);
    expect(pending.err).toBe(ownPending(own, 4));
    expect(pending.err).not.toContain(NOBODY_ANNOUNCED);
    expect(pending.err).not.toContain("no announcement opens");
    expect(status(j.intent)).toBe(IntentStatus.Open);
  });

  it("does not wait when the announcement already shows, and a deliver then judge right after it pays at once", async () => {
    await keyed("worker.json");
    const delivered = await cli(["deliver", "--keypair", "worker.json", "--intent", j.intent, "--artifact", j.artifact, "--work-url", WORK_URL, "--yes"], {});
    expect([delivered.code, delivered.err]).toEqual([EXIT_OK, ""]);
    const run = await cli(judging(j, "--yes"), j.keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", seq: "1" });
    expect(h.sleeps).toEqual([]);
  });

  it("defaults to a short wait, takes 0 to refuse at once, and refuses the flag with --watch", () => {
    const base = ["judge", "--keypair", "k", "--owner", j.w.owner.address, "--nonce", "0", "--spec", "s", "--artifact", "a", "--run", "true"];
    expect(parse(base)).toMatchObject({ announceWait: ANNOUNCE_WAIT });
    expect(parse([...base, "--announce-wait", "0"])).toMatchObject({ announceWait: 0 });
    expect(() => parse([...base, "--announce-wait", "601"])).toThrow("--announce-wait must be an integer from 0 to 600");
    const watch = ["judge", "--keypair", "k", "--owner", j.w.owner.address, "--nonce", "0", "--spec", "s", "--watch", "--run", "true"];
    expect(parse(watch)).toMatchObject({ announceWait: 0 });
    expect(() => parse([...watch, "--announce-wait", "5"])).toThrow(WATCH_TAKES_NO_WAIT);
  });

  it("refuses at once with --announce-wait 0", async () => {
    const none = await cli(judging(j, "--announce-wait", "0", "--yes"), j.keys);
    expect([none.code, h.sleeps]).toEqual([EXIT_REFUSED, []]);
    expect(none.err).toContain(waitedFor(0));
    const usage = await cli(judging(j, "--announce-wait", "x"), j.keys);
    expect(usage.code).toBe(EXIT_USAGE);
  });
});
