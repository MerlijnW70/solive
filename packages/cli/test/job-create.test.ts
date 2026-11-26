import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { parse } from "../src/args.js";
import { JOB_FUND, JOB_NEEDS_CREATE, NAME_RULE } from "../src/job-args.js";
import { BACKUP_DIR_ENV, escrowNotThisJob, backupNeeded, backupReadBack, backupDiffers, JOB_EXISTS, jobFilePath, JOB_PREVIEW, specChanged, specCrlf, specEmpty } from "../src/job-create.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { cli, funded, h, HOME, runtime, world } from "./harness.js";

function preset(at: Address): void {
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

const SPEC = "# job\n\nDeliver answer.txt holding 42.\n";
const KEYS = `${HOME}/.config/intent-engine/job-keys`;
const JOBS = `${HOME}/.config/intent-engine/jobs`;
const BACKUP = "/backup";

type Setup = { hirer: KeyPairSigner; spec: string; dir: string };

async function written(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  h.files.set(path, text);
}

async function setup(): Promise<Setup> {
  await world();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const hirer = await funded();
  const dir = await mkdtemp(join(tmpdir(), "job-create-"));
  const spec = join(dir, "SPEC.md");
  await written(spec, SPEC);
  return { hirer, spec, dir };
}

const creating = (s: Setup, ...more: string[]) => ["job", "create", "--url", "devnet", "--keypair", "hirer.json", "--name", "sg-job", "--spec", s.spec, "--worker-key", "kw1", "--amount", "0.01", "--backup-dir", BACKUP, "--no-publish-spec", ...more];

const lamportsOf = (address: string): bigint => {
  const held = h.svm.getAccount(address as Address);
  return held.exists ? BigInt(held.lamports) : 0n;
};

describe("job create makes a funded worker key and an attested escrow from a spec file in one command", () => {
  let s: Setup;

  beforeEach(async () => {
    s = await setup();
  });

  it("previews every send first, then funds the backed-up key, creates the escrow judged by this wallet and saves the answer", async () => {
    const before = h.wires.length;
    const preview = await cli(creating(s), { "hirer.json": s.hirer });
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const shown = preview.json() as { worker: { address: string; keypair: string; backup: string; created: boolean }; fund: { summary: string[] }; escrow: { sent: boolean }; sent: boolean; next: string };
    expect(h.wires).toHaveLength(before);
    expect(shown).toMatchObject({ sent: false, next: JOB_PREVIEW, judge: s.hirer.address, spec_sha256: createHash("sha256").update(SPEC).digest("hex"), escrow: { sent: false } });
    expect(shown.worker).toMatchObject({ keypair: `${KEYS}/kw1.json`, backup: `${BACKUP}/kw1.json`, created: true });
    expect(h.files.get(`${BACKUP}/kw1.json`)).toBe(h.files.get(`${KEYS}/kw1.json`));
    expect(shown.fund.summary[0]).toContain(`to the worker key ${shown.worker.address}`);
    expect(h.files.has(jobFilePath(JOBS, "sg-job"))).toBe(false);
    expect(lamportsOf(shown.worker.address)).toBe(0n);

    const made = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const answer = made.json() as { intent: Address; nonce: string; sent: boolean; worker: { address: string; created: boolean } };
    expect(answer).toMatchObject({ sent: true, worker: { address: shown.worker.address, created: false } });
    expect(lamportsOf(shown.worker.address)).toBe(JOB_FUND);
    const intent = h.svm.getAccount(answer.intent);
    expect(intent.exists).toBe(true);
    if (intent.exists) {
      expect(getIntentDecoder().decode(intent.data).owner).toBe(s.hirer.address);
    }
    const saved = JSON.parse(h.files.get(jobFilePath(JOBS, "sg-job")) ?? "{}") as Record<string, unknown>;
    expect(saved).toMatchObject({ job: "sg-job", state: "created", intent: answer.intent, nonce: answer.nonce, judge: s.hirer.address, worker: "kw1", worker_address: shown.worker.address, amount: "0.01" });
  });

  it("sends nothing on a second run with the same name and reports the escrow it made", async () => {
    const first = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    expect(first.code).toBe(EXIT_OK);
    const sent = h.wires.length;
    const again = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    expect([again.code, again.err]).toEqual([EXIT_OK, ""]);
    expect(again.json()).toMatchObject({ existing: true, sent: false, next: JOB_EXISTS, intent: first.json()["intent"], nonce: first.json()["nonce"] });
    expect(h.wires).toHaveLength(sent);
  });

  it("finishes a job whose escrow landed before its answer was saved, without sending again", async () => {
    const first = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    const path = jobFilePath(JOBS, "sg-job");
    const saved = JSON.parse(h.files.get(path) ?? "{}") as Record<string, unknown>;
    h.files.set(path, JSON.stringify({ ...saved, state: "creating", escrow_signature: null }));
    const sent = h.wires.length;
    const again = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    expect(again.json()).toMatchObject({ existing: true, sent: false, intent: first.json()["intent"], state: "created" });
    expect(JSON.parse(h.files.get(path) ?? "{}")).toMatchObject({ state: "created" });
    expect(h.wires).toHaveLength(sent);
  });

  it("refuses to adopt another job's escrow that took its saved nonce, and sends nothing", async () => {
    const other = await cli(creating(s, "--yes").map((arg) => (arg === "sg-job" ? "other-job" : arg === "kw1" ? "kw2" : arg)), { "hirer.json": s.hirer });
    expect(other.code).toBe(EXIT_OK);
    const taken = other.json() as { intent: Address; nonce: string };
    const mine = join(s.dir, "mine.md");
    await written(mine, `${SPEC}mine\n`);
    const mineSha = createHash("sha256").update(`${SPEC}mine\n`).digest("hex");
    const path = jobFilePath(JOBS, "sg-job");
    const crashed = { job: "sg-job", state: "creating", spec: mine, spec_sha256: mineSha, judge: s.hirer.address, worker: "kw1", worker_address: s.hirer.address, worker_keypair: `${KEYS}/kw1.json`, worker_backup: `${BACKUP}/kw1.json`, amount: "0.01", nonce: taken.nonce, intent: taken.intent, fund_signature: null, escrow_signature: null, created_at: "2026-11-26T00:00:00.000Z" };
    h.files.set(path, JSON.stringify(crashed));
    const sent = h.wires.length;
    const refused = await cli(creating(s, "--yes").map((arg) => (arg === s.spec ? mine : arg)), { "hirer.json": s.hirer });
    expect([refused.code, refused.out, refused.err]).toEqual([EXIT_FAILED, "", escrowNotThisJob("sg-job", taken.intent, taken.nonce, `spec hash is not ${mineSha}`, path)]);
    expect(JSON.parse(h.files.get(path) ?? "{}")).toMatchObject({ state: "creating" });
    expect(h.wires).toHaveLength(sent);
    const amount = await cli(creating(s, "--yes").map((arg) => (arg === "sg-job" ? "third" : arg)), { "hirer.json": s.hirer });
    expect(amount.code).toBe(EXIT_OK);
    const third = jobFilePath(JOBS, "third");
    const kept = JSON.parse(h.files.get(third) ?? "{}") as Record<string, string>;
    h.files.set(third, JSON.stringify({ ...kept, state: "creating", amount: "0.02" }));
    const wrongAmount = await cli(creating(s, "--yes").map((arg) => (arg === "sg-job" ? "third" : arg)), { "hirer.json": s.hirer });
    expect(wrongAmount.err).toBe(escrowNotThisJob("third", kept["intent"] as Address, String(kept["nonce"]), "amount is not 0.02 SOL", third));
  });

  it("checks the escrow before funding the key, so an escrow the hirer cannot pay funds nothing", async () => {
    const sent = h.wires.length;
    const refused = await cli(creating(s, "--yes").map((arg) => (arg === "0.01" ? "5000" : arg)), { "hirer.json": s.hirer });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.out).toBe("");
    expect(h.wires).toHaveLength(sent);
    const key = JSON.parse(h.files.get(`${KEYS}/kw1.json`) ?? "[]") as number[];
    const address = (await createKeyPairSignerFromBytes(Uint8Array.from(key))).address;
    expect(lamportsOf(address)).toBe(0n);
    expect(h.files.has(jobFilePath(JOBS, "sg-job"))).toBe(false);
  });

  it("does not fund the key when its backup reads back with other bytes", async () => {
    const live = runtime({ "hirer.json": s.hirer });
    const tampering = { ...live, saveText: async (path: string, text: string, secret: boolean) => live.saveText(path, path.startsWith(BACKUP) ? text.replace("[", "[ ") : text, secret) };
    const out: string[] = [];
    const err: string[] = [];
    const sent = h.wires.length;
    const code = await main(creating(s, "--yes"), tampering, { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect([code, out, err]).toEqual([EXIT_FAILED, [], [backupReadBack(`${BACKUP}/kw1.json`)]]);
    expect(h.wires).toHaveLength(sent);
    const key = JSON.parse(h.files.get(`${KEYS}/kw1.json`) ?? "[]") as number[];
    expect(key).toHaveLength(64);
    expect(h.files.has(jobFilePath(JOBS, "sg-job"))).toBe(false);
  });

  it("never overwrites a backup that holds another key", async () => {
    h.files.set(`${BACKUP}/kw1.json`, "[1,2,3]");
    const refused = await cli(creating(s, "--yes"), { "hirer.json": s.hirer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, backupDiffers(`${BACKUP}/kw1.json`, `${KEYS}/kw1.json`)]);
    expect(h.files.get(`${BACKUP}/kw1.json`)).toBe("[1,2,3]");
  });

  it("refuses CR line ends, an empty spec, a missing backup folder and a changed spec, sending nothing", async () => {
    const sent = h.wires.length;
    const crlf = join(s.dir, "crlf.md");
    await writeFile(crlf, "# job\r\n");
    const empty = join(s.dir, "empty.md");
    await written(empty, "");
    const withSpec = (path: string) => creating(s, "--yes").map((arg) => (arg === s.spec ? path : arg));
    expect(await cli(withSpec(crlf), { "hirer.json": s.hirer })).toMatchObject({ code: EXIT_FAILED, err: specCrlf(crlf) });
    expect(await cli(withSpec(empty), { "hirer.json": s.hirer })).toMatchObject({ code: EXIT_FAILED, err: specEmpty(empty) });
    const noBackup = creating(s, "--yes").filter((arg, at, all) => arg !== "--backup-dir" && all[at - 1] !== "--backup-dir");
    expect(await cli(noBackup, { "hirer.json": s.hirer })).toMatchObject({ code: EXIT_FAILED, err: backupNeeded });
    expect(h.wires).toHaveLength(sent);
    h.env[BACKUP_DIR_ENV] = BACKUP;
    const fromEnv = await cli(noBackup, { "hirer.json": s.hirer });
    expect(fromEnv.code).toBe(EXIT_OK);
    const changed = join(s.dir, "changed.md");
    await writeFile(changed, `${SPEC}more\n`);
    const kept = JSON.parse(h.files.get(jobFilePath(JOBS, "sg-job")) ?? "{}") as { spec_sha256: string };
    const now = createHash("sha256").update(`${SPEC}more\n`).digest("hex");
    expect(await cli(withSpec(changed), { "hirer.json": s.hirer })).toMatchObject({ code: EXIT_FAILED, err: specChanged("sg-job", kept.spec_sha256, now, jobFilePath(JOBS, "sg-job")) });
  });

  it("parses its options and refuses bad names", () => {
    expect(parse(["job", "create", "--keypair", "k", "--name", "a", "--spec", "s", "--worker-key", "w", "--amount", "0.5"])).toMatchObject({ name: "job-create", job: "a", workerKey: "w", amount: "0.5", fund: JOB_FUND, expiresIn: "604800", noPublishSpec: false });
    expect(() => parse(["job", "create", "--keypair", "k", "--name", "../x", "--spec", "s", "--worker-key", "w", "--amount", "0.5"])).toThrow(`--name ${NAME_RULE}`);
    expect(() => parse(["job", "make", "--keypair", "k"])).toThrow(JOB_NEEDS_CREATE);
    expect(() => parse(["job", "create", "--keypair", "k", "--name", "a", "--spec", "s", "--worker-key", "w", "--amount", "0"])).toThrow("--amount");
  });

  it("exits with usage for a bad flag", async () => {
    const bad = await cli([...creating(s), "--fund", "x"], { "hirer.json": s.hirer });
    expect(bad.code).toBe(EXIT_USAGE);
  });
});
