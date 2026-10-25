import { join } from "node:path";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { parseEncryptionKey, WALLET_KEY_GIVEN } from "@intent-engine/core/internal";
import { ProfileHistoryIncomplete } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { keepsKey, noKeyAtCreation } from "@intent-engine/client/internal";
import { ENCRYPTION_KEY_FILE, ENCRYPTION_KEY_NEEDS_WALLET } from "../src/arg-values.js";
import { parse } from "../src/args.js";
import { GIVE_KEY_FLAG, sealedOnDevice } from "../src/judge.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { encryptionKeyNext } from "../src/sealed-commands.js";
import { griefed, keyed } from "./announce.js";
import { announce, ENDPOINT, job, judging, KEY_FILE, kinds, LEVELS, logged, NEW_KEY_FILE, PATH, payeeOf, profileEntry, publish, run, sealedKind, sha, statusOf, WORK } from "./encryption-job.js";
import { balance, funded, h, transport } from "./harness.js";
import { device, found, MESSAGE, messageThen, signing } from "./ledger-device.js";

describe("a judge's encryption key", () => {
  it("is made by profile encryption-key new, published from a Ledger by profile set, kept by a later set, and removed with none or close only once no open escrow names the judge", async () => {
    const j = await job();
    expect(JSON.parse(h.files.get(KEY_FILE) ?? "{}")).toMatchObject({ public_key: j.publicKey });
    const again = await run(["profile", "encryption-key", "new", "--out", KEY_FILE]);
    expect(again.code).toBe(EXIT_FAILED);
    expect(encryptionKeyNext(j.publicKey)).toContain(`profile set --encryption-key ${j.publicKey}`);
    const setting = ["profile", "set", "--keypair", PATH, "--skills", "judge", "--endpoint", ENDPOINT];
    const publishing = device(j.key, signing(LEVELS, j.key));
    const published = await run([...setting, "--encryption-key", j.publicKey, "--yes"], publishing);
    expect([published.code, published.err]).toEqual([EXIT_OK, ""]);
    publishing.store.ensureQueueEmpty();
    expect(published.json()["summary"]).toContain(`Encryption key: ${j.publicKey}; deliveries are sealed to it`);
    const shown = async () => (await run(["profile", "show", "--wallet", j.key.address])).json()["encryption_key"];
    expect(await shown()).toBe(j.publicKey);
    const keeping = device(j.key, signing(LEVELS, j.key));
    expect((await run([...setting, "--yes"], keeping)).code).toBe(EXIT_OK);
    expect(await shown()).toBe(j.publicKey);
    for (const dropping of [[...setting, "--encryption-key", "none", "--yes"], ["profile", "close", "--keypair", PATH, "--yes"]]) {
      const held = device(j.key, found(LEVELS, j.key));
      const refused = await run(dropping, held);
      expect([refused.code, refused.err]).toEqual([EXIT_FAILED, keepsKey(j.key.address, [j.intent])]);
      expect(held.signed).toEqual([]);
    }
    const next = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotating = device(j.key, signing(LEVELS, j.key));
    expect((await run([...setting, "--encryption-key", String(next.json()["encryption_key"]), "--yes"], rotating)).code).toBe(EXIT_OK);
    expect(await shown()).toBe(next.json()["encryption_key"]);
    const cancelled = await run(["cancel", "--keypair", "owner.json", "--nonce", "0", "--yes"], undefined, { "owner.json": j.w.owner });
    expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    const removing = device(j.key, signing(LEVELS, j.key));
    expect((await run([...setting, "--encryption-key", "none", "--yes"], removing)).code).toBe(EXIT_OK);
    expect(await shown()).toBeNull();
  });

  it("lets a judge on a Ledger open the announcement sealed to its profile key and pay its worker, signing only the release message", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    const worker = await keyed();
    const announced = await announce(j, worker);
    expect(announced.sealedTo.map(sealedKind)).toEqual(["profile"]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j), "--yes"], refusing, { "payer.json": j.payer });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`the earlier announcement ${announced.announcement} (seq 1) by ${worker.address} sealed to the encryption key of ${j.key.address}'s profile`);
    expect(refused.err).toContain(GIVE_KEY_FLAG);
    expect(refusing.signed).toEqual([]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, announcement: announced.announcement, signature: expect.any(String), feePayer: j.payer.address });
    expect(judged.json()["skipped"]).toBeUndefined();
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
    expect(balance(await payeeOf(j, worker.address))).toBeGreaterThan(0n);
  });

  it("refuses a Ledger judge when an earlier announcement is sealed to the key derived from its wallet", async () => {
    const j = await job();
    logged(j, [profileEntry(j, j.publicKey, 0)]);
    const announced = await announce(j, await keyed());
    expect(announced.sealedTo.map(sealedKind)).toEqual(["wallet"]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], refusing, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, sealedOnDevice(PATH, j.intent)]);
    expect(refusing.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("refuses an escrow made before the Ledger judge published an encryption key, naming why", async () => {
    const j = await job();
    const late = await publish(j, j.publicKey, 1);
    logged(j, [late]);
    await announce(j, await keyed());
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], refusing, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, noKeyAtCreation(j.key.address, j.intent)]);
    expect(refused.err).toContain("name a judge whose profile publishes an encryption key before the escrow is made");
    expect(refusing.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("passes over a blob announced first under the judge's real profile fingerprint that does not open, lists it, and pays the honest worker", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    const [griefer, worker] = [await keyed(), await keyed()];
    const grief = await griefed(j.intent, griefer, j.key.address, [{ wallet: j.key.address, encryptionKey: parseEncryptionKey(j.publicKey) }], WORK);
    await announce(j, worker);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, seq: "2" });
    expect(judged.json()["skipped"]).toEqual([{ announcement: grief, seq: "1", worker: griefer.address, reason: "does-not-open" }]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("refuses when the profile history cannot be read back to the escrow's creation", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 1)]);
    await announce(j, await keyed());
    h.firstSlot = 1n;
    const ledger = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, new ProfileHistoryIncomplete(j.key.address).message]);
    expect(ledger.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("passes over an earlier announcement of other work without listing it, the device signing only the release message", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    const [copier, worker] = [await keyed(), await keyed()];
    await announce(j, copier, sha("other work").toString("hex"));
    await announce(j, worker);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, seq: "2" });
    expect(judged.json()["skipped"]).toBeUndefined();
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("refuses an announcement sealed to an old published key until its key file is given, then pays its earlier announcer", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const [first, second] = [await keyed(), await keyed()];
    const old = await announce(j, first);
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 2, true);
    const later = await announce(j, second);
    expect([old.sealedTo.map(sealedKind), later.sealedTo.map(sealedKind)]).toEqual([["profile"], ["profile"]]);
    logged(j, [created, rotation]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", NEW_KEY_FILE), "--yes"], refusing, { "payer.json": j.payer });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`the earlier announcement ${old.announcement} (seq 1) by ${first.address} sealed to an earlier encryption key of ${j.key.address}'s profile`);
    expect(refusing.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE, "--encryption-keypair", NEW_KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: first.address });
    expect(balance(await payeeOf(j, first.address))).toBeGreaterThan(0n);
  });

  it("lets a committee member on a Ledger open with its encryption key file, vote on the device, and the release pays the worker", async () => {
    const other = await keyed();
    let committee = "" as Address;
    const j = await job(async (key) => {
      const made = await createClient({ url: "http://cluster", transport }).createCommittee({ members: [key.address, other.address], threshold: 1, feeWallet: key.address, payer: await funded() });
      committee = made.committee;
      return committee;
    });
    logged(j, [await publish(j, j.publicKey, 0)]);
    const worker = await keyed();
    const announced = await announce(j, worker);
    const members = announced.sealedTo.map((recipient) => (typeof recipient === "string" ? recipient : recipient.wallet));
    expect(announced.sealedTo.map(sealedKind)).toEqual(members.map((member) => (member === j.key.address ? "profile" : "wallet")));
    const verdict = join(j.dir, "member.verdict");
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE, "--verdict", verdict), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(judged.json()).toMatchObject({ verdict: "pass", committee, payTo: worker.address, vote: { member: j.key.address, announcement: announced.announcement, salt: announced.salt } });
    const released = await run(["committee", "release", "--keypair", "payer.json", "--vote", verdict, "--yes"], undefined, { "payer.json": j.payer });
    expect([released.code, released.err]).toEqual([EXIT_OK, ""]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
    expect(balance(await payeeOf(j, worker.address))).toBeGreaterThan(0n);
  });

  it("is a key file that only decrypts: a wallet key file or a Ledger is refused, and mcp takes it only with --wallet", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    await announce(j, await keyed());
    await keyed("wallet.json");
    const ledger = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", "wallet.json"), "--yes"], ledger, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, `--encryption-keypair wallet.json: ${WALLET_KEY_GIVEN}`]);
    expect(ledger.signed).toEqual([]);
    expect(() => parse(judging(j, "--encryption-keypair", PATH))).toThrow(ENCRYPTION_KEY_FILE);
    expect(() => parse(["mcp", "--encryption-keypair", KEY_FILE])).toThrow(ENCRYPTION_KEY_NEEDS_WALLET);
    expect(parse(["mcp", "--wallet", "--encryption-keypair", KEY_FILE])).toMatchObject({ name: "mcp", encryptionKeypairs: [KEY_FILE] });
  });
});
