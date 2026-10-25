import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner, type Signature } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { TransactionMetadata } from "litesvm";
import { Kind } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { SHA256_NEEDED, usageOf } from "../src/args.js";
import { DELIVER_ONE_OF } from "../src/job-args.js";
import { type AnnouncementPlan } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { loadAnnouncement } from "@intent-engine/client/internal";
import { ANNOUNCE_FIRST } from "../src/agent/wallet/delivery.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, FEE_BPS, funded, h, NOW, transport, world } from "./harness.js";

describe("cli against the deployed engine", () => {
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;

  beforeEach(async () => {
    ({ owner, inputMint, outputMint } = await world());
  });

  const announcedLines = (plan: AnnouncementPlan, sha256: string, url: string, worker: string, judge: string) => [
    `Announces: the work with sha256 ${sha256} to the proof escrow ${plan.intent} in ${plan.announcement}, whose commitment ${plan.commitment} binds it to ${worker} and the salt ${plan.salt}`,
    `Seals: the salt and the url ${url} to ${judge} (the key derived from its wallet), so only they can open it`,
    `Pays: the announcement's rent and the fee, from ${worker}; the rent returns to it when the announcement closes`,
  ];

  it("lists open proof escrows as jobs and announces a delivery to the judge, previewing unless --yes", async () => {
    h.watched.push(owner.address);
    h.engineLog = [];
    const judge = await generateKeyPairSigner();
    const worker = await funded();
    const client = createClient({ url: "http://cluster", transport });
    const specHash = new Uint8Array(32).fill(7);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
    const job = await client.createIntent({ signer: owner, params, inputMint, outputMint, nonce: 3n, expiresAt: NOW + 3_600n });
    const swap = await client.createIntent({ signer: owner, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n }, inputMint, outputMint, nonce: 4n, expiresAt: NOW + 3_600n });

    expect((await cli(["jobs", "--attestor", judge.address], {})).json()).toEqual({
      jobs: [
        {
          intent: job.intent,
          owner: owner.address,
          nonce: "3",
          attestor: judge.address,
          specHash: "07".repeat(32),
          specUrl: null,
          sells: "100",
          judgeFee: "0",
          net: "99",
          feeBps: FEE_BPS,
          inputMint,
          expiresAt: (NOW + 3_600n).toString(),
          net_pay: "0.000099",
          payable: true,
          takes_claims: false,
          claimed_by: null,
          claim_ends: null,
          waiting: 0,
          freeze_authority: null,
        },
      ],
    });
    expect((await cli(["jobs"], {})).json()["jobs"]).toHaveLength(1);
    expect((await cli(["jobs", "--attestor", worker.address], {})).json()).toEqual({ jobs: [] });

    const work = "ab".repeat(32);
    const url = "https://" + "example.org/work";
    const args = ["deliver", "--keypair", "w.json", "--intent", job.intent, "--sha256", work.toUpperCase(), "--work-url", url];
    const plan = await client.plan.announce({ worker, intent: job.intent, sha256: work, url });
    const summary = announcedLines(plan, work, url, worker.address, judge.address);
    const preview = await cli(args, { "w.json": worker });
    expect(preview.json()).toMatchObject({ intent: job.intent, attestor: judge.address, announcement: plan.announcement, commitment: plan.commitment, salt: plan.salt, summary, sent: false });
    const sent = await cli([...args, "--yes"], { "w.json": worker });
    expect(sent.json()).toMatchObject({ intent: job.intent, attestor: judge.address, summary, seq: "1", sent: true, signature: expect.any(String) });
    expect((await cli([...args, "--yes"], { "w.json": worker })).json()).toMatchObject({ announcement: plan.announcement, seq: "1", sent: false });

    const bad = await cli([...args.slice(0, 6), "xyz", ...args.slice(7)], { "w.json": worker });
    expect([bad.code, bad.err]).toEqual([EXIT_USAGE, SHA256_NEEDED]);
    const local = await cli([...args.slice(0, 8), "http://example.org/work"], { "w.json": worker });
    expect(local.code).toBe(EXIT_USAGE);
    expect(local.err).toContain("--work-url must be an https url");
    const refused = await cli(["deliver", "--keypair", "w.json", "--intent", swap.intent, "--sha256", work, "--work-url", "https://example.org/work"], { "w.json": worker });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`intent ${swap.intent} is not a proof escrow`);
  });

  it("deliver --artifact announces the same hash that hash --artifact prints", async () => {
    const judge = await generateKeyPairSigner();
    const worker = await funded();
    const client = createClient({ url: "http://cluster", transport });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const job = await client.createIntent({ signer: owner, params, inputMint, outputMint, nonce: 3n, expiresAt: NOW + 3_600n });
    const dir = await mkdtemp(join(tmpdir(), "deliver-"));
    await mkdir(join(dir, "work", "src"), { recursive: true });
    await writeFile(join(dir, "work", "answer.txt"), "42\n");
    await writeFile(join(dir, "work", "src", "notes.txt"), "how\n");
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    for (const artifact of [join(dir, "work"), join(dir, "work.mjs")]) {
      const hashed = await cli(["hash", "--artifact", artifact], {});
      const sha256 = (hashed.json() as { sha256: string }).sha256;
      const args = ["deliver", "--keypair", "w.json", "--intent", job.intent, "--artifact", artifact, "--work-url", "https://example.org/work"];
      const preview = await cli(args, { "w.json": worker });
      expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
      const plan = await client.plan.announce({ worker, intent: job.intent, sha256, url: "https://" + "example.org/work" });
      expect(preview.json()).toMatchObject({ commitment: plan.commitment, warnings: [ANNOUNCE_FIRST] });
      expect(preview.json()["summary"] as string[]).toEqual(announcedLines(plan, sha256, "https://" + "example.org/work", worker.address, judge.address));
      const sent = await cli([...args, "--yes"], { "w.json": worker });
      expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
      const landed = h.svm.getTransaction(sent.json()["signature"] as Signature);
      if (!(landed instanceof TransactionMetadata)) {
        throw new Error("the delivery did not land");
      }
      expect((await loadAnnouncement(transport, plan.announcement))?.state).toBe("announced");
      expect(landed.logs().some((line) => line.includes("example.org"))).toBe(false);
    }
  });

  it("deliver refuses both --artifact and --sha256, and neither", async () => {
    const worker = await funded();
    const dir = await mkdtemp(join(tmpdir(), "deliver-"));
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 3n });
    const base = ["deliver", "--keypair", "w.json", "--intent", intent, "--work-url", "https://example.org/work"];
    const sent = h.wires.length;
    for (const extra of [["--artifact", join(dir, "work.mjs"), "--sha256", "ab".repeat(32)], []]) {
      const refused = await cli([...base, ...extra], { "w.json": worker });
      expect(refused).toMatchObject({ code: EXIT_USAGE, err: DELIVER_ONE_OF, out: "" });
    }
    expect(h.wires).toHaveLength(sent);
    expect(usageOf("deliver")).toMatchObject({ usage: expect.stringContaining("(--artifact <file or directory> | --sha256 <64 hex>)") });
  });
});
