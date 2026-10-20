import { join } from "node:path";
import { type Address, generateKeyPairSigner, type Signature } from "@solana/kit";
import { TransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import { IntentStatus, keyFingerprint, openingMemo, parseEncryptionKey, sealDelivery, WALLET_KEY_GIVEN, x25519PublicOf } from "@intent-engine/core";
import { createClient, keepsKey, noKeyAtCreation, NOT_PUBLISHED_KEY, NOT_VERSION_3, ProfileHistoryIncomplete } from "@intent-engine/client";
import { ENCRYPTION_KEY_FILE, ENCRYPTION_KEY_NEEDS_WALLET } from "../src/arg-values.js";
import { parse } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { encryptionKeyNext } from "../src/sealed-commands.js";
import { announcement, keyed, saltFor } from "./announce.js";
import { announce, ENDPOINT, forged, job, judging, KEY_FILE, kinds, LEVELS, logged, memoAt, NEW_KEY_FILE, PATH, payeeOf, publish, run, sha, statusOf, WORK, WORK_URL } from "./encryption-job.js";
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

  it("lets a judge on a Ledger open the announcement sealed to its profile key and pay the earliest announcer, signing only the release message", async () => {
    const j = await job();
    const profile = await publish(j, j.publicKey, 0);
    const worker = await generateKeyPairSigner();
    const announced = await announce(j, worker, 1);
    expect(announced.sealedKeys).toEqual(["profile"]);
    logged(j, [profile, announced]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j), "--yes"], refusing, { "payer.json": j.payer });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`the announcement ${announced.signature} by ${worker.address} for intent ${j.intent}`);
    expect(refused.err).toContain(`the encryption key ${j.publicKey} the judge's profile named when it landed`);
    expect(refusing.signed).toEqual([]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, signature: expect.any(String), feePayer: j.payer.address });
    expect(judged.json()["skipped"]).toBeUndefined();
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
    expect(balance(await payeeOf(j, worker.address))).toBeGreaterThan(0n);
  });

  it("refuses an escrow made before the Ledger judge published an encryption key, naming why", async () => {
    const j = await job();
    const worker = await generateKeyPairSigner();
    const late = await publish(j, j.publicKey, 1);
    logged(j, [late, await announce(j, worker, 2)]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], refusing, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, noKeyAtCreation(j.key.address, j.intent)]);
    expect(refused.err).toContain("name a judge whose profile publishes an encryption key before the escrow is made");
    expect(refusing.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("passes over work sealed to the old key that lands in the same slot as a rotation, as built, and pays a later announcer", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const [raced, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const before = await announce(j, raced, 2);
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 2, true);
    logged(j, [created, before, rotation, await announce(j, worker, 3)]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", NEW_KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, skipped: [`skipped the announcement ${before.signature} by ${raced.address}: ${NOT_PUBLISHED_KEY}`] });
  });

  it("passes over junk announced first, a forged fingerprint of the Ledger's wallet key, a v2 blob and keys it never held, and pays the honest worker", async () => {
    const j = await job();
    const profile = await publish(j, j.publicKey, 0);
    const [griefer, stranger, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
    const walletPrint = await keyFingerprint(x25519PublicOf(j.key.address));
    const forgedWallet = await forged(j, 1, griefer.address, [walletPrint]);
    const blob = await sealDelivery({ salt: saltFor(j.intent), url: WORK_URL }, [stranger.address], j.intent);
    const random = memoAt(2, griefer.address, announcement(j.intent, griefer.address, WORK, blob));
    const legacy = await forged(j, 3, griefer.address, [walletPrint], 2);
    logged(j, [profile, forgedWallet, random, legacy, await announce(j, worker, 4)]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address });
    expect(judged.json()["skipped"]).toEqual([
      `skipped the announcement ${forgedWallet.signature} by ${griefer.address}: ${NOT_PUBLISHED_KEY}`,
      `skipped the announcement ${random.signature} by ${griefer.address}: ${NOT_PUBLISHED_KEY}`,
      `skipped the announcement ${legacy.signature} by ${griefer.address}: ${NOT_VERSION_3}`,
    ]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("passes over a forged fingerprint of an old key posted after a rotation, and pays the honest worker", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 1, true);
    const [griefer, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const stale = await forged(j, 2, griefer.address, [await keyFingerprint(parseEncryptionKey(j.publicKey))]);
    logged(j, [created, rotation, stale, await announce(j, worker, 3)]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", NEW_KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address, skipped: [`skipped the announcement ${stale.signature} by ${griefer.address}: ${NOT_PUBLISHED_KEY}`] });
  });

  it("refuses when the profile history cannot be read back to the earliest unopened announcement", async () => {
    const j = await job();
    const griefer = await generateKeyPairSigner();
    const early = await forged(j, 0, griefer.address, ["00".repeat(8)]);
    const profile = await publish(j, j.publicKey, 1);
    logged(j, [early, profile, await announce(j, await generateKeyPairSigner(), 2)]);
    h.firstSlot = 1n;
    const ledger = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, new ProfileHistoryIncomplete(j.key.address).message]);
    expect(ledger.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
  });

  it("lets a Ledger judge publish the earlier announcements' salts through its fee payer, the device signing only the release message", async () => {
    const j = await job();
    const profile = await publish(j, j.publicKey, 0);
    const [copier, worker] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const before = await announce(j, copier, 1, sha("other work").toString("hex"));
    logged(j, [profile, before, await announce(j, worker, 2)]);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    const openings = judged.json()["openings"] as { memo: string; signature: string | null }[];
    expect(openings).toEqual([{ memo: openingMemo({ intent: j.intent, salts: [before.salt] }), signature: expect.any(String) }]);
    expect(h.svm.getTransaction(openings[0]?.signature as Signature)).toBeInstanceOf(TransactionMetadata);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: worker.address });
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
  });

  it("refuses an announcement sealed to an old published key until its key file is given, then pays its earlier announcer", async () => {
    const j = await job();
    const created = await publish(j, j.publicKey, 0);
    const [first, second] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const old = await announce(j, first, 1);
    const rotated = await run(["profile", "encryption-key", "new", "--out", NEW_KEY_FILE]);
    const rotation = await publish(j, String(rotated.json()["encryption_key"]), 2, true);
    const later = await announce(j, second, 3);
    expect([old.sealedKeys, later.sealedKeys]).toEqual([["profile"], ["profile"]]);
    logged(j, [created, old, rotation, later]);
    const refusing = device(j.key, found(LEVELS, j.key));
    const refused = await run([...judging(j, "--encryption-keypair", NEW_KEY_FILE), "--yes"], refusing, { "payer.json": j.payer });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`the announcement ${old.signature} by ${first.address} for intent ${j.intent}`);
    expect(refused.err).toContain(`the encryption key ${j.publicKey} the judge's profile named when it landed`);
    expect(refusing.signed).toEqual([]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Open);
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE, "--encryption-keypair", NEW_KEY_FILE), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", payTo: first.address });
    expect(balance(await payeeOf(j, first.address))).toBeGreaterThan(0n);
  });

  it("lets a committee member on a Ledger open with its encryption key file, vote on the device, and the release pays the worker", async () => {
    const other = await generateKeyPairSigner();
    let committee = "" as Address;
    const j = await job(async (key) => {
      const made = await createClient({ url: "http://cluster", transport }).createCommittee({ members: [key.address, other.address], threshold: 1, feeWallet: key.address, payer: await funded() });
      committee = made.committee;
      return committee;
    });
    const profile = await publish(j, j.publicKey, 0);
    const worker = await generateKeyPairSigner();
    const announced = await announce(j, worker, 1);
    logged(j, [profile, announced]);
    expect(announced.sealedTo.map((member, at) => [member, announced.sealedKeys[at]])).toEqual(announced.sealedTo.map((member) => [member, member === j.key.address ? "profile" : "wallet"]));
    const verdict = join(j.dir, "member.verdict");
    const ledger = device(j.key, [...found(LEVELS, j.key), ...messageThen()]);
    const judged = await run([...judging(j, "--encryption-keypair", KEY_FILE, "--verdict", verdict), "--yes"], ledger, { "payer.json": j.payer });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(judged.json()).toMatchObject({ verdict: "pass", committee, payTo: worker.address, vote: { member: j.key.address, salt: announced.salt } });
    const released = await run(["committee", "release", "--keypair", "payer.json", "--vote", verdict, "--yes"], undefined, { "payer.json": j.payer });
    expect([released.code, released.err]).toEqual([EXIT_OK, ""]);
    expect(statusOf(j.intent)).toBe(IntentStatus.Filled);
    expect(balance(await payeeOf(j, worker.address))).toBeGreaterThan(0n);
  });

  it("is a key file that only decrypts: a wallet key file or a Ledger is refused, and mcp takes it only with --wallet", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0), await announce(j, await generateKeyPairSigner(), 1)]);
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
