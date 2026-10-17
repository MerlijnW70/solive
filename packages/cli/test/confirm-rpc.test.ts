import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { deliveryMemo, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, sortMembers } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { balance, cli, creation, funded, h, NOW, transport, world } from "./harness.js";
import { announced, cliWith, type Disagreement, disagreements, SECOND, SECOND_URL, secondNode, UNREADABLE, WORK_URL } from "./confirm-node.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const CORRECT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Job = { owner: Address; intent: Address; inputMint: Address; spec: string; artifact: string; dir: string; worker: Address; keys: Record<string, KeyPairSigner> };

async function escrow(attestor: (keys: Record<string, KeyPairSigner>) => Promise<Address>): Promise<Job> {
  const w = await world();
  const keys: Record<string, KeyPairSigner> = {};
  const worker = (await generateKeyPairSigner()).address;
  const dir = await mkdtemp(join(tmpdir(), "confirm-rpc-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, CORRECT);
  const params = {
    kind: Kind.AttestedResult,
    amountIn: 100n,
    minResult: 1n,
    maxResult: 1n,
    attestor: await attestor(keys),
    specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()),
    judgeFee: 0n,
  } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
    signer: w.owner,
    params,
    inputMint: w.inputMint,
    outputMint: w.outputMint,
    nonce: 0n,
    expiresAt: NOW + 3_600n,
  });
  h.engineLog = [announced("first", 5n, worker, deliveryMemo({ intent, sha256: sha(CORRECT), url: WORK_URL })), creation(intent)];
  return { owner: w.owner.address, intent, inputMint: w.inputMint, spec, artifact, dir, worker, keys };
}

const alone = () =>
  escrow(async (keys) => {
    const judge = await funded();
    keys["judge.json"] = judge;
    return judge.address;
  });

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const paid = async (job: Job) => balance(await findAssociatedTokenAddress({ owner: job.worker, mint: job.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const lies = (job: Job): Disagreement[] => disagreements(job.intent, job.owner, sha(CORRECT));

describe("judge --confirm-url", () => {
  const judging = (job: Job, ...more: string[]) => [
    "judge", "--keypair", "judge.json", "--owner", job.owner, "--nonce", "0", "--spec", job.spec, "--artifact", job.artifact, "--sandbox", "viper", ...more,
  ];

  it("pays when both nodes agree", async () => {
    const job = await alone();
    const node = secondNode();
    const sent = await cliWith(judging(job, "--confirm-url", SECOND, "--yes"), job.keys, node);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.urls).toContain(SECOND_URL);
    expect(node.reads).toBeGreaterThan(0);
    expect(sent.json()).toMatchObject({ verdict: "pass", signature: expect.any(String) });
    expect(status(job.intent)).toBe(IntentStatus.Filled);
    expect(await paid(job)).toBeGreaterThan(0n);
  });

  it("refuses with ConfirmMismatch and sends nothing when the second node differs", async () => {
    for (const i of [0, 1, 2, 3]) {
      const job = await alone();
      const { field, lie, second } = lies(job)[i] as Disagreement;
      const node = secondNode();
      node.lie = lie;
      const wires = h.wires.length;
      const refused = await cliWith(judging(job, "--confirm-url", SECOND, "--yes"), job.keys, node);
      expect(refused.code, field).toBe(EXIT_FAILED);
      expect(refused.out).toBe("");
      expect(refused.err).toContain(`ConfirmMismatch: the two RPC nodes report a different ${field}`);
      expect(refused.err).toContain(second);
      expect(refused.err).toContain("nothing was signed or sent");
      expect(h.wires.length).toBe(wires);
      expect(status(job.intent)).toBe(IntentStatus.Open);
      expect(await paid(job)).toBe(-1n);
    }
  });

  it("refuses when the second node cannot be read, on a preview too", async () => {
    const job = await alone();
    const node = secondNode();
    node.lie = { down: true };
    for (const more of [[], ["--yes"]]) {
      const simulated = h.simulated.length;
      const refused = await cliWith(judging(job, "--confirm-url", SECOND, ...more), job.keys, node);
      expect(refused.code).toBe(EXIT_FAILED);
      expect(refused.err).toContain(`ConfirmMismatch: ${UNREADABLE.second}`);
      expect(h.simulated.length).toBe(simulated);
    }
    expect(status(job.intent)).toBe(IntentStatus.Open);
  });

  it("reads one node, as today, without the flag", async () => {
    const job = await alone();
    const node = secondNode();
    node.lie = { down: true };
    const sent = await cliWith(judging(job, "--yes"), job.keys, node);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.urls).not.toContain(SECOND_URL);
    expect(node.reads).toBe(0);
    expect(status(job.intent)).toBe(IntentStatus.Filled);
  });
});

describe("committee release --confirm-url", () => {
  async function voted() {
    const job = await escrow(async (keys) => {
      const members = await Promise.all([0, 1].map(() => funded()));
      members.forEach((m, i) => (keys[`m${i}.json`] = m));
      keys["payer.json"] = await funded();
      const fees = (await generateKeyPairSigner()).address;
      const addresses = sortMembers(members.map((m) => m.address));
      const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", fees, "--yes"], keys);
      expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
      return created.json()["committee"] as Address;
    });
    const votes = ["m0.json", "m1.json"].map((member) => ({ member, file: join(job.dir, `${member}.verdict`) }));
    for (const { member, file } of votes) {
      const judged = await cli(["judge", "--keypair", member, "--owner", job.owner, "--nonce", "0", "--spec", job.spec, "--artifact", job.artifact, "--sandbox", "viper", "--verdict", file], job.keys);
      expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    }
    const release = ["committee", "release", "--keypair", "m0.json", ...votes.flatMap(({ file }) => ["--vote", file]), "--sha256", sha(CORRECT), "--yes"];
    return { job, release };
  }

  it("refuses each disagreement and an unreadable second node without sending, then releases when both agree", async () => {
    const { job, release } = await voted();
    const node = secondNode();
    for (const { field, lie, second } of [...lies(job), UNREADABLE]) {
      node.lie = lie;
      const wires = h.wires.length;
      const refused = await cliWith([...release, "--confirm-url", SECOND], job.keys, node);
      expect(refused.code, field).toBe(EXIT_FAILED);
      expect(refused.err).toContain(field === "second node" ? `ConfirmMismatch: ${second}` : `ConfirmMismatch: the two RPC nodes report a different ${field}`);
      expect(refused.err).toContain(second);
      expect(refused.err).toContain("nothing was signed or sent");
      expect(h.wires.length).toBe(wires);
      expect(status(job.intent)).toBe(IntentStatus.Open);
    }
    node.lie = {};
    const sent = await cliWith([...release, "--confirm-url", SECOND], job.keys, node);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(status(job.intent)).toBe(IntentStatus.Filled);
    expect(await paid(job)).toBeGreaterThan(0n);
  });

  it("reads one node, as today, without the flag", async () => {
    const { job, release } = await voted();
    const node = secondNode();
    node.lie = { down: true };
    const sent = await cliWith(release, job.keys, node);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(node.reads).toBe(0);
    expect(status(job.intent)).toBe(IntentStatus.Filled);
  });
});
