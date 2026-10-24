import { type Address, getBase16Encoder, type KeyPairSigner, signBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { createClient, keepsKey, noJudgeKey, WARN_NO_JUDGE_KEY } from "@intent-engine/client";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK } from "../src/main.js";
import { keyed } from "./announce.js";
import { announce, call, type Job, job, KEY_FILE, kinds, lastWireSigners, LEVELS, logged, NEW_KEY_FILE, PATH, publish, run, served, sha, statusOf, WORK } from "./encryption-job.js";
import { funded, h, transport } from "./harness.js";
import { device, found, MESSAGE, messageThen, transactionThen } from "./ledger-device.js";

const committeeJob = (other: KeyPairSigner): Promise<Job> =>
  job(async (key) => (await createClient({ url: "http://cluster", transport }).createCommittee({ members: [key.address, other.address], threshold: 1, feeWallet: key.address, payer: await funded() })).committee);

async function twoAnnouncements(j: Job, copier: KeyPairSigner, worker: KeyPairSigner): Promise<void> {
  logged(j, [await publish(j, j.publicKey, 0)]);
  await announce(j, copier, sha("other work").toString("hex"));
  await announce(j, worker);
}

describe("the MCP wallet's encryption key", () => {
  it("refuses to close the Ledger wallet's profile while an open escrow names it, and warns a hirer naming a judge without a key", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    h.env[ENV_KEYPAIR] = PATH;
    const client = await served(device(j.key, found(LEVELS, j.key)), []);
    const closing = await call(client, "wallet_profile", { close: true });
    expect(closing).toMatchObject({ error: true, value: { code: "KeyInUse", hint: keepsKey(j.key.address, [j.intent]) } });
    const keyless = (await funded()).address;
    const args = ["create", "attested", "--keypair", "owner.json", "--input-mint", j.w.inputMint, "--output-mint", j.w.outputMint, "--expires-in", "3600"];
    const terms = ["--units", "raw", "--amount-in", "100", "--min-result", "1", "--max-result", "1", "--nonce", "5", "--spec-hash", "ab".repeat(32)];
    const shown = await run([...args, ...terms, "--attestor", keyless], undefined, { "owner.json": j.w.owner });
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()["warnings"]).toContain(noJudgeKey(keyless));
    const keyedJudge = await run([...args, ...terms, "--attestor", j.key.address], undefined, { "owner.json": j.w.owner });
    expect(JSON.stringify(keyedJudge.json()["warnings"])).not.toContain(WARN_NO_JUDGE_KEY);
  });

  it("lets a committee member on the Ledger wallet open with mcp --encryption-keypair and vote, and refuses without it naming the setting", async () => {
    const other = await keyed();
    const j = await committeeJob(other);
    logged(j, [await publish(j, j.publicKey, 0)]);
    const announcer = await keyed();
    const announced = await announce(j, announcer);
    h.env[ENV_KEYPAIR] = PATH;
    const ballot = { owner: j.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
    const closed = await served(device(j.key, found(LEVELS, j.key)), []);
    const refused = await call(closed, "wallet_committee_vote", ballot);
    expect(refused).toMatchObject({ error: true, value: { code: "KeyNotGiven" } });
    expect(String(refused.value["hint"])).toContain(`the encryption key of ${j.key.address}'s profile`);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const client = await served(ledger, ["--encryption-keypair", KEY_FILE]);
    const shown = await call(client, "wallet_committee_vote", ballot);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value).toMatchObject({ announcement: announced.announcement, worker: announcer.address });
    expect(ledger.signed).toEqual([]);
    const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shown.value["approval"], send: true });
    expect(voted.error, JSON.stringify(voted.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
  });

  it("releases from the Ledger wallet across a key rotation, the fee payer signing the release, and refuses until the old key file is given", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const [copier, worker] = [await keyed(), await keyed()];
    const before = await announce(j, copier, sha("other work").toString("hex"));
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 2, true);
    logged(j, [created, rotation]);
    await announce(j, worker);
    h.env[ENV_KEYPAIR] = PATH;
    const keys = { "payer.json": j.payer };
    const release = { owner: j.w.owner.address, nonce: "0", delivered_sha256: WORK };
    const partial = await served(device(j.key, found(LEVELS, j.key)), ["--fee-payer", "payer.json", "--encryption-keypair", NEW_KEY_FILE], keys);
    const refused = await call(partial, "wallet_attest", release);
    expect(refused).toMatchObject({ error: true, value: { code: "KeyNotGiven" } });
    expect(String(refused.value["hint"])).toContain(`the earlier announcement ${before.announcement} (seq 1) by ${copier.address}`);
    expect(String(refused.value["hint"])).toContain(`an earlier encryption key of ${j.key.address}'s profile`);
    expect(h.wires).toEqual([]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const client = await served(ledger, ["--fee-payer", "payer.json", "--encryption-keypair", KEY_FILE, "--encryption-keypair", NEW_KEY_FILE], keys);
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value).toMatchObject({ pay_to: worker.address, seq: "2" });
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(h.wires).toHaveLength(1);
    expect(lastWireSigners()).toEqual([j.payer.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("releases a split through the fee payer, the Ledger wallet signing only the envelope", async () => {
    const j = await job();
    const [copier, worker] = [await keyed(), await keyed()];
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
    expect(h.wires).toHaveLength(2);
    expect(lastWireSigners()).toEqual([j.payer.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("releases a committee's votes from the Ledger wallet, the device signing the vote and then the previewed release transaction", async () => {
    const other = await keyed();
    const j = await committeeJob(other);
    const [copier, worker] = [await keyed(), await keyed()];
    await twoAnnouncements(j, copier, worker);
    h.env[ENV_KEYPAIR] = PATH;
    const ballot = { owner: j.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen(), ...transactionThen()]);
    const client = await served(ledger, ["--encryption-keypair", KEY_FILE]);
    const shownVote = await call(client, "wallet_committee_vote", ballot);
    const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shownVote.value["approval"], send: true });
    expect(voted.error, JSON.stringify(voted.value)).toBe(false);
    const release = { ...ballot, votes: [voted.value["vote"] as { member: Address; signature: string }] };
    const shown = await call(client, "wallet_committee_release", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value).toMatchObject({ worker: worker.address, seq: "2" });
    const sent = await call(client, "wallet_committee_release", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(lastWireSigners()).toEqual([j.key.address]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });
});
