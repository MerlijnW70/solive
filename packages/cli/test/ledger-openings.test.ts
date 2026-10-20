import { type Address, generateKeyPairSigner, getBase16Encoder, type KeyPairSigner, signBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { createClient, keepsKey, WARN_NO_JUDGE_KEY } from "@intent-engine/client";
import { OPENINGS_NEED_FEE_PAYER } from "../src/agent/wallet/openings.js";
import { SALTS_SEALED } from "../src/agent/wallet/record.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK } from "../src/main.js";
import { announce, call, type Job, job, KEY_FILE, kinds, lastWireSigners, LEVELS, logged, NEW_KEY_FILE, PATH, publish, run, served, sha, statusOf, WORK } from "./encryption-job.js";
import { funded, h, transport } from "./harness.js";
import { device, found, MESSAGE, messageThen, transactionThen } from "./ledger-device.js";

const committeeJob = (other: KeyPairSigner): Promise<Job> =>
  job(async (key) => (await createClient({ url: "http://cluster", transport }).createCommittee({ members: [key.address, other.address], threshold: 1, feeWallet: key.address, payer: await funded() })).committee);

async function twoAnnouncements(j: Job, copier: KeyPairSigner, worker: KeyPairSigner): Promise<void> {
  const profile = await publish(j, j.publicKey, 0);
  logged(j, [profile, await announce(j, copier, 1, sha("other work").toString("hex")), await announce(j, worker, 2)]);
}

describe("the MCP wallet's encryption key", () => {
  it("refuses to close the Ledger wallet's profile while an open escrow names it, and warns a hirer naming a judge without a key", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    h.env[ENV_KEYPAIR] = PATH;
    const client = await served(device(j.key, found(LEVELS, j.key)), []);
    const closing = await call(client, "wallet_profile", { close: true });
    expect(closing).toMatchObject({ error: true, value: { code: "SealedSalts", hint: keepsKey(j.key.address, [j.intent]) } });
    const keyless = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", j.w.inputMint, "--output-mint", j.w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--nonce", "5", "--spec-hash", "ab".repeat(32)];
    const shown = await run([...args, ...terms, "--attestor", keyless], undefined, { "owner.json": j.w.owner });
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()["warnings"]).toContain(`${WARN_NO_JUDGE_KEY}: the profile of ${keyless} publishes no encryption key`);
    const keyed = await run([...args, ...terms, "--attestor", j.key.address], undefined, { "owner.json": j.w.owner });
    expect(JSON.stringify(keyed.json()["warnings"])).not.toContain(WARN_NO_JUDGE_KEY);
  });

  it("lets a committee member on the Ledger wallet open with mcp --encryption-keypair and vote, and refuses without it naming the setting", async () => {
    const other = await generateKeyPairSigner();
    const j = await committeeJob(other);
    const profile = await publish(j, j.publicKey, 0);
    const announcer = await generateKeyPairSigner();
    const worker = announcer.address;
    logged(j, [profile, await announce(j, announcer, 1)]);
    h.env[ENV_KEYPAIR] = PATH;
    const ballot = { owner: j.w.owner.address, nonce: "0", pay_to: worker, result: "1", delivered_sha256: WORK };
    const closed = await served(device(j.key, found(LEVELS, j.key)), []);
    const refused = await call(closed, "wallet_committee_vote", ballot);
    expect(refused).toMatchObject({ error: true, value: { code: "SealedSalts" } });
    expect(String(refused.value["hint"])).toContain(`the encryption key ${j.publicKey} the judge's profile named when it landed`);
    expect(SALTS_SEALED).toContain("mcp --encryption-keypair");
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const client = await served(ledger, ["--encryption-keypair", KEY_FILE]);
    const shown = await call(client, "wallet_committee_vote", ballot);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(ledger.signed).toEqual([]);
    const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shown.value["approval"], send: true });
    expect(voted.error, JSON.stringify(voted.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
  });

  it("releases from the Ledger wallet across a key rotation, the fee payer signing the release and the opening, and refuses until the old key file is given", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const [copier, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const before = await announce(j, copier, 1, sha("other work").toString("hex"));
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 2, true);
    logged(j, [created, before, rotation, await announce(j, worker, 3)]);
    h.env[ENV_KEYPAIR] = PATH;
    const keys = { "payer.json": j.payer };
    const release = { owner: j.w.owner.address, nonce: "0", pay_to: worker.address, delivered_sha256: WORK };
    const partial = await served(device(j.key, found(LEVELS, j.key)), ["--fee-payer", "payer.json", "--encryption-keypair", NEW_KEY_FILE], keys);
    const refused = await call(partial, "wallet_attest", release);
    expect(refused).toMatchObject({ error: true, value: { code: "SealedSalts" } });
    expect(String(refused.value["hint"])).toContain(`the announcement ${before.signature} by ${copier.address}`);
    expect(String(refused.value["hint"])).toContain(`the encryption key ${j.publicKey} the judge's profile named when it landed`);
    expect(h.wires).toEqual([]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const client = await served(ledger, ["--fee-payer", "payer.json", "--encryption-keypair", KEY_FILE, "--encryption-keypair", NEW_KEY_FILE], keys);
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(sent.value["opening_signatures"]).toHaveLength(1);
    expect(h.wires).toHaveLength(2);
    expect(lastWireSigners()).toEqual([j.payer.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("publishes a split release's earlier salts through the fee payer, the Ledger wallet signing only the envelope", async () => {
    const j = await job();
    const [copier, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    await twoAnnouncements(j, copier, worker);
    h.env[ENV_KEYPAIR] = PATH;
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const client = await served(ledger, ["--fee-payer", "payer.json", "--encryption-keypair", KEY_FILE], { "payer.json": j.payer });
    const split = { owner: j.w.owner.address, nonce: "0", recipients: [{ wallet: worker.address, weight: 10_000 }], delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest_split", split);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown.value["envelope"])));
    const signature = Buffer.from(await signBytes(worker.keyPair.privateKey, envelope)).toString("hex");
    const recipients = [{ wallet: worker.address, weight: 10_000, signature }];
    const sent = await call(client, "wallet_attest_split", { ...split, recipients, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(sent.value["opening_signatures"]).toHaveLength(1);
    expect(h.wires).toHaveLength(2);
    expect(lastWireSigners()).toEqual([j.payer.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("releases a committee's votes from the Ledger wallet with the fee payer signing the openings, and refuses without one before anything is signed", async () => {
    const other = await generateKeyPairSigner();
    const j = await committeeJob(other);
    const [copier, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    await twoAnnouncements(j, copier, worker);
    h.env[ENV_KEYPAIR] = PATH;
    const ballot = { owner: j.w.owner.address, nonce: "0", pay_to: worker.address, result: "1", delivered_sha256: WORK };
    const votes = async (client: Awaited<ReturnType<typeof served>>) => {
      const shown = await call(client, "wallet_committee_vote", ballot);
      const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shown.value["approval"], send: true });
      expect(voted.error, JSON.stringify(voted.value)).toBe(false);
      return [voted.value["vote"] as { member: Address; signature: string }];
    };
    const unpaid = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const alone = await served(unpaid, ["--encryption-keypair", KEY_FILE]);
    const refused = await call(alone, "wallet_committee_release", { ...ballot, votes: await votes(alone) });
    expect(refused).toMatchObject({ error: true, value: { code: "NoFeePayer", hint: OPENINGS_NEED_FEE_PAYER } });
    unpaid.store.ensureQueueEmpty();
    expect(kinds(unpaid)).toEqual([MESSAGE]);
    expect(h.wires).toEqual([]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen(), ...transactionThen()]);
    const client = await served(ledger, ["--fee-payer", "payer.json", "--encryption-keypair", KEY_FILE], { "payer.json": j.payer });
    const release = { ...ballot, votes: await votes(client) };
    const shown = await call(client, "wallet_committee_release", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const sent = await call(client, "wallet_committee_release", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(sent.value["opening_signatures"]).toHaveLength(1);
    expect(lastWireSigners()).toEqual([j.payer.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });
});
