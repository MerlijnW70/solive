import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { NOBODY_ANNOUNCED } from "../src/announcement-views.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced, griefed, keyed } from "./announce.js";
import { cli, funded, NOW, transport, world } from "./harness.js";

const WORK = createHash("sha256").update("the committee work").digest("hex");
const OTHER = createHash("sha256").update("other work").digest("hex");
const NOTHING_OPENS = "no announcement opens to this work; its worker announces it first with deliver";
const url = (name: string) => "https://" + "example.org/" + name;

async function panel() {
  const w = await world();
  const members = await Promise.all([0, 1, 2].map(() => funded()));
  const payer = await funded();
  const keys: Record<string, KeyPairSigner> = { "payer.json": payer };
  members.forEach((m, i) => (keys[`m${i}.json`] = m));
  const addresses = sortMembers(members.map((m) => m.address));
  const feeWallet = (await generateKeyPairSigner()).address;
  const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", feeWallet, "--yes"], keys);
  expect([created.code, created.err]).toStrictEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  const params = {
    kind: Kind.AttestedResult,
    amountIn: 100n,
    minResult: 1n,
    maxResult: 1n,
    attestor: committee,
    specHash: new Uint8Array(32).fill(5),
    judgeFee: 10n,
  } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const vote = (member: string, extra: string[] = []) => ["committee", "vote", "--keypair", member, "--owner", w.owner.address, "--nonce", "0", "--sha256", WORK, "--result", "1", ...extra];
  const first = `m${members.findIndex((m) => m.address === addresses[0])}.json`;
  return { w, keys, committee, addresses, first, intent, vote, dir: await mkdtemp(join(tmpdir(), "kill-committee-")) };
}

describe("committee vote refusals", () => {
  it("says nobody announced when the escrow has no announcements, and the work was not announced when others exist", async () => {
    const p = await panel();
    const empty = await cli(p.vote("m0.json"), p.keys);
    expect(empty.code).toBe(EXIT_FAILED);
    expect(empty.err).toContain(NOBODY_ANNOUNCED);
    await announced(p.intent, await keyed(), OTHER, url("other"));
    const other = await cli(p.vote("m0.json"), p.keys);
    expect(other.code).toBe(EXIT_FAILED);
    expect(other.err).toContain(NOTHING_OPENS);
    expect(other.err).not.toContain(NOBODY_ANNOUNCED);
  }, 60_000);
});

describe("committee vote output", () => {
  it("lists skipped announcements only when some were skipped, and names the file only when one was written", async () => {
    const p = await panel();
    await announced(p.intent, await keyed(), WORK, url("work"));
    const clean = await cli(p.vote("m0.json"), p.keys);
    expect([clean.code, clean.err]).toStrictEqual([EXIT_OK, ""]);
    expect(clean.json()).not.toHaveProperty("skipped");
    expect(clean.json()["signed"]).toBe(false);
    const file = join(p.dir, "v0.json");
    const signed = await cli(p.vote("m0.json", ["--yes"]), p.keys);
    expect(signed.json()["signed"]).toBe(true);
    expect(signed.json()).not.toHaveProperty("written");
    expect(signed.json()).not.toHaveProperty("skipped");
    const written = await cli(p.vote("m0.json", ["--yes", "--out", file]), p.keys);
    expect(written.json()["signed"]).toBe(true);
    expect(written.json()["written"]).toBe(file);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ kind: "committee-vote", sha256: WORK });
  }, 60_000);

  it("reports the announcements it skipped before the one it voted on", async () => {
    const p = await panel();
    await announced(p.intent, await keyed(), OTHER, url("other"));
    await griefed(p.intent, await keyed(), p.committee, p.addresses, WORK, true);
    await announced(p.intent, await keyed(), WORK, url("work"));
    const preview = await cli(p.vote(p.first), p.keys);
    expect([preview.code, preview.err]).toStrictEqual([EXIT_OK, ""]);
    expect((preview.json()["skipped"] as unknown[]).length).toBeGreaterThan(0);
    const signed = await cli(p.vote(p.first, ["--yes"]), p.keys);
    expect((signed.json()["skipped"] as unknown[]).length).toBeGreaterThan(0);
    expect(signed.json()["signed"]).toBe(true);
  }, 60_000);
});

describe("committee release", () => {
  it("refuses votes whose escrow differs, or whose committee differs, from the one the release is for", async () => {
    const p = await panel();
    await announced(p.intent, await keyed(), WORK, url("work"));
    const files: string[] = [];
    for (const member of ["m0.json", "m2.json"]) {
      const file = join(p.dir, `${member}.vote`);
      const done = await cli(p.vote(member, ["--yes", "--out", file]), p.keys);
      expect(done.json()["signed"]).toBe(true);
      files.push(file);
    }
    const release = (list: string[]) => cli(["committee", "release", "--keypair", "m2.json", ...list.flatMap((f) => ["--vote", f])], p.keys);
    const intact = await release(files);
    expect([intact.code, intact.err]).toStrictEqual([EXIT_OK, ""]);
    const stranger = (await generateKeyPairSigner()).address;
    for (const field of ["intent", "committee"] as const) {
      const changed: string[] = [];
      for (const file of files) {
        const copy = join(p.dir, `${field}-${files.indexOf(file)}.vote`);
        await writeFile(copy, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), [field]: stranger }));
        changed.push(copy);
      }
      const refused = await release(changed);
      expect([field, refused.code]).toStrictEqual([field, EXIT_FAILED]);
      expect(refused.err).toContain("the votes are for escrow " + (field === "intent" ? stranger : p.intent) + " and committee " + (field === "committee" ? stranger : p.committee));
    }
  }, 60_000);
});
