import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { loadAnnouncement } from "@intent-engine/client/internal";
import { NOBODY_ANNOUNCED } from "../src/announcement-views.js";
import { GIVE_KEY_FLAG } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced, griefed, keyed, WORK_URL } from "./announce.js";
import { balance, cli, h, NOW, transport, type World, world } from "./harness.js";

const SPEC = "answer.txt holds 42\n";
const CHECK = `test "$(cat "$ARTIFACT_PATH")" = 42`;

type Job = { w: World; judge: KeyPairSigner; intent: Address; spec: string; artifact: string; sha256: string; keys: Record<string, KeyPairSigner> };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await keyed("judge.json");
  const dir = await mkdtemp(join(tmpdir(), "announce-judge-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "answer.txt");
  await writeFile(spec, SPEC);
  await writeFile(artifact, "42\n");
  const specHash = new Uint8Array(createHash("sha256").update(SPEC).digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const sha256 = createHash("sha256").update("42\n").digest("hex");
  return { w, judge, intent, spec, artifact, sha256, keys: { "judge.json": judge } };
}

const judging = (j: Job, ...more: string[]) => [
  "judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--artifact", j.artifact, "--run", CHECK, "--sandbox", "none", ...more,
];

const paid = async (j: Job, wallet: Address) => balance(await findAssociatedTokenAddress({ owner: wallet, mint: j.w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const status = (intent: Address) => {
  const held = h.svm.getAccount(intent);
  return held.exists ? getIntentDecoder().decode(held.data).status : undefined;
};

describe("judge on announcements", () => {
  let j: Job;

  beforeEach(async () => {
    j = await job();
  });

  it("skips a griefer's blob under the judge's real fingerprint, pays the earliest worker whose announcement opens to the work, and prints the skipped one", async () => {
    const griefer = await keyed();
    const grief = await griefed(j.intent, griefer, j.judge.address, [j.judge.address], j.sha256);
    const first = await keyed("first.json");
    const second = await keyed("second.json");
    for (const path of ["first.json", "second.json"]) {
      const delivered = await cli(["deliver", "--keypair", path, "--intent", j.intent, "--artifact", j.artifact, "--work-url", WORK_URL, "--yes"], {});
      expect([delivered.code, delivered.err]).toEqual([EXIT_OK, ""]);
      expect(delivered.json()).toMatchObject({ sent: true, attestor: j.judge.address, sealed_to: [j.judge.address] });
    }
    const listed = await cli(["deliveries", "--intent", j.intent], {});
    expect(listed.json()).toMatchObject({ complete: true, closed: false, missing: [], next_seq: "4" });
    expect((listed.json()["announcements"] as { worker: string }[]).map(({ worker }) => worker)).toEqual([griefer.address, first.address, second.address]);
    const preview = await cli(judging(j), j.keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ verdict: "pass", payTo: first.address, seq: "2", signature: null, skipped: [{ announcement: grief, seq: "1", worker: griefer.address, reason: "does-not-open" }] });
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const run = await cli(judging(j, "--yes"), j.keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ verdict: "pass", payTo: first.address, skipped: [{ announcement: grief, reason: "does-not-open" }] });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
    expect(await paid(j, first.address)).toBeGreaterThan(0n);
    expect(await paid(j, second.address)).toBe(-1n);
    expect(await paid(j, griefer.address)).toBe(-1n);
  });

  it("pays exactly the announcement firstOpening names, not an earlier one of other work", async () => {
    const early = await keyed();
    const other = await announced(j.intent, early, createHash("sha256").update("other work").digest("hex"));
    const worker = await keyed("worker.json");
    const made = await announced(j.intent, worker, j.sha256);
    const keypair = h.keypairs.get(j.judge.address);
    const first = await createClient({ url: "http://cluster", transport }).firstOpening({ intent: j.intent, sha256: j.sha256, keypair });
    expect(first).toMatchObject({ announcement: made.announcement, seq: 2n, worker: worker.address });
    const run = await cli(judging(j, "--yes"), j.keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.json()).toMatchObject({ announcement: first.announcement, payTo: first.worker, seq: String(first.seq), salt: first.salt });
    expect((await loadAnnouncement(transport, first.announcement))?.state).toBe("paid");
    expect((await loadAnnouncement(transport, other.announcement))?.state).toBe("announced");
    expect(await paid(j, worker.address)).toBeGreaterThan(0n);
    expect(await paid(j, early.address)).toBe(-1n);
  });

  it("refuses with the reason and what to do next, and signs nothing, until it is given the key an earlier announcement is sealed to", async () => {
    const none = await cli(judging(j, "--yes"), j.keys);
    expect(none.code).toBe(EXIT_FAILED);
    expect(none.err).toContain(NOBODY_ANNOUNCED);
    const made = await cli(["profile", "encryption-key", "new", "--out", "judge.enc"], {});
    const key = String(made.json()["encryption_key"]);
    const profile = await cli(["profile", "set", "--keypair", "judge.json", "--skills", "judge", "--endpoint", "https://" + "judge.example", "--encryption-key", key, "--yes"], j.keys);
    expect([profile.code, profile.err]).toEqual([EXIT_OK, ""]);
    const worker = await keyed();
    await announced(j.intent, worker, j.sha256);
    const blind = await cli(judging(j, "--yes"), j.keys);
    expect(blind.code).toBe(EXIT_FAILED);
    expect(blind.err).toContain("which no key given here opens");
    expect(blind.err).toContain(GIVE_KEY_FLAG);
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const unlocked = await cli(judging(j, "--encryption-keypair", "judge.enc", "--yes"), j.keys);
    expect([unlocked.code, unlocked.err]).toEqual([EXIT_OK, ""]);
    expect(unlocked.json()).toMatchObject({ verdict: "pass", payTo: worker.address });
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });
});
