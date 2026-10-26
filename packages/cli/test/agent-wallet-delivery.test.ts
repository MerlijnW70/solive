import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase64Encoder, getTransactionDecoder, partiallySignTransaction, signBytes } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { NATIVE_MINT, DEVNET_TEST_MINT as TEST_TOKEN } from "@intent-engine/core";
import { getIntentCreatedEventEncoder, saltMessage, specMemo } from "@intent-engine/core/internal";
import { loadAnnouncement } from "@intent-engine/client/internal";
import { claimsOf } from "../src/agent/claims.js";
import { SKIP_REASONS } from "../src/announcement-views.js";
import { ANNOUNCE_FIRST, DELIVER_NEXT, planOf } from "../src/agent/wallet/delivery.js";
import { NO_JOB_NOW, PUBLISH_PROFILE } from "../src/agent/jobs.js";
import { notEarliest } from "../src/agent/wallet.js";
import { WORK_DIFFERS, WORK_OPENS } from "../src/agent/wallet/work.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { call, connect, fresh, ok, tag } from "./agent-wallet-kit.js";
import { announced, griefed, keyed } from "./announce.js";
import { FEE_BPS, funded, h, transport } from "./harness.js";
import { approved } from "./approved.js";

const url = (name: string) => "https://" + "example.org/" + name;

describe("the wallet server's deliveries", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  async function judged(attestor?: Address) {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: attestor ?? wallet, spec_hash: "5c".repeat(32) }));
    return { wallet, intent: escrow["intent"] as Address, nonce: escrow["nonce"] as string };
  }

  it("publishes a spec url with a proof escrow, lists it as a job and announces delivered work to its judge", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    h.engineLog = [];
    const judge = (await generateKeyPairSigner()).address;
    const specHash = "5c".repeat(32);
    const specUrl = url("jobs/spec.md");
    const terms = { sell: "SOL", amount: "0.05", attestor: judge, min_result: "1", max_result: "1" };
    expect((await call(client, "wallet_escrow", { ...terms, spec_url: specUrl })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_url" }] });
    expect((await call(client, "wallet_escrow", { ...terms, spec_hash: specHash, spec_url: "http://" + "example.org/spec" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_url" }] });
    h.wires.length = 0;
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { ...terms, spec_hash: specHash, spec_url: specUrl }));
    expect(escrow["summary"]).toContain(`Publishes: the acceptance spec's url ${specUrl}, in a memo the owner signs`);
    expect(Buffer.from(h.wires[0] as string, "base64").toString("latin1")).toContain(specMemo(specUrl));
    const intent = escrow["intent"] as Address;
    const plain = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { ...terms }));
    const job = { intent, owner, nonce: escrow["nonce"], attestor: judge, spec_hash: specHash, spec_url: null, sells: (LAMPORTS_PER_SOL / 20n).toString(), pays: "0.05", judge_fee: "0", fee_bps: FEE_BPS, input_mint: NATIVE_MINT, net_pay: "0.049975", payable: true, takes_claims: false, claimed_by: null, claim_ends: null, waiting: 0, freeze_authority: null };
    expect(await ok(client, "find_jobs", { attestor: judge })).toEqual({ fee_bps: expect.any(Number), jobs: [{ ...job, expires_at: expect.any(String) }], next: expect.stringContaining("solive_get_spec") });
    const created = getIntentCreatedEventEncoder().encode({ intent, owner, nonce: BigInt(escrow["nonce"] as string), kind: 4, inputMint: NATIVE_MINT, outputMint: TEST_TOKEN, receiver: owner, escrowed: LAMPORTS_PER_SOL / 20n, expiresAt: 0n, rentPayer: owner, flags: 0, bounty: 0, createFee: 0 });
    h.engineLog = [
      { signature: testSignature("noise"), slot: 2n, blockTime: null, failed: false, emitted: [], memos: [specMemo("https://" + "evil.example/spec")] },
      { signature: testSignature("create"), slot: 1n, blockTime: null, failed: false, emitted: [tag(created)], memos: [specMemo(specUrl)], memoSigners: [[owner]] },
    ];
    expect((await ok(client, "find_jobs", { attestor: judge }))["jobs"]).toMatchObject([{ ...job, spec_url: specUrl }]);
    expect(await ok(client, "find_jobs", { attestor: owner })).toEqual({ fee_bps: expect.any(Number), jobs: [], next: `${NO_JOB_NOW}; ${PUBLISH_PROFILE}` });
    h.engineLog = [];
    const work = "e7".repeat(32);
    const delivery = { intent, sha256: work.toUpperCase(), url: url("work.tar") };
    const preview = await ok(client, "wallet_deliver", delivery);
    expect(preview).toMatchObject({ intent, owner, nonce: escrow["nonce"], attestor: judge, sha256: work, url: delivery.url, sealed_to: [judge], warnings: [ANNOUNCE_FIRST], sent: false, next: DELIVER_NEXT });
    expect(preview["commitment"]).toMatch(/^[0-9a-f]{64}$/);
    expect(preview["summary"][0]).toBe(
      `Announces: the work with sha256 ${work} to the proof escrow ${intent} in ${preview["announcement"]}, whose commitment ${preview["commitment"]} binds it to this wallet and a salt only its key derives`,
    );
    expect(preview["summary"][1]).toBe(`Seals: the salt and the url ${delivery.url} to ${judge} (the key derived from its wallet), so only they can open it`);
    expect(await loadAnnouncement(transport, preview["announcement"] as Address)).toBeNull();
    h.wires.length = 0;
    const sent = await ok(client, "wallet_deliver", { ...delivery, send: true });
    expect(sent).toMatchObject({
      announcement: preview["announcement"],
      seq: "1",
      sent: true,
      signature: expect.any(String),
      next: `announced to ${judge}; solive_wallet_receipt with owner ${owner} and nonce ${escrow["nonce"]} shows when it is paid; give it wait, in seconds, to wait for the pay`,
    });
    const wire = Buffer.from(h.wires[0] as string, "base64").toString("latin1");
    expect(wire).not.toContain(delivery.url);
    expect(await ok(client, "wallet_deliver", delivery)).toMatchObject({ seq: "1", sent: false });
    expect((await call(client, "wallet_deliver", { ...delivery, url: url("a".repeat(400)) })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "url" }] });
    expect((await call(client, "wallet_deliver", { ...delivery, url: "ftp://" + "example.org/x" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "url" }] });
    expect((await call(client, "wallet_deliver", { ...delivery, sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
    expect((await call(client, "wallet_deliver", { ...delivery, intent: plain["intent"] })).value).toMatchObject({ code: "NotAProof" });
    expect((await call(client, "wallet_deliver", { ...delivery, intent: judge })).value).toMatchObject({ code: "NotFound" });
  });

  it("lists the announcements to an escrow it judges, fetches the work and releases only to the first announcement that opens to it", async () => {
    const { wallet, intent, nonce } = await judged();
    const [worker, copier] = [await keyed(), await keyed()];
    const work = "the work\n";
    const sha256 = createHash("sha256").update(work).digest("hex");
    h.specPages.set(url("work"), new TextEncoder().encode(work));
    h.specPages.set(url("own"), new TextEncoder().encode("other"));
    h.specPages.set(url("stolen"), new TextEncoder().encode(work));
    const first = await announced(intent, worker, sha256, url("work"));
    const own = await announced(intent, copier, "aa".repeat(32), url("own"));
    const copy = await announced(intent, copier, sha256, url("stolen"));
    const listed = await ok(client, "wallet_check_delivery", { intent });
    expect(listed).toMatchObject({ intent, owner: wallet, nonce, spec_hash: "5c".repeat(32), open: true, complete: true, closed: false, next_seq: "4", missing: [], mine: [] });
    expect(listed["announcements"]).toMatchObject([
      { announcement: first.announcement, seq: "1", worker: worker.address, state: "announced" },
      { announcement: own.announcement, seq: "2", worker: copier.address },
      { announcement: copy.announcement, seq: "3", worker: copier.address },
    ]);
    expect(JSON.stringify(listed)).not.toContain("example.org");
    const fetched = await ok(client, "wallet_fetch_work", { intent });
    expect(fetched).toMatchObject({ announcement: first.announcement, worker: worker.address, url: url("work"), sha256, opens_commitment: true, untrusted_text: work, first: { announcement: first.announcement, worker: worker.address }, next: WORK_OPENS });
    const fromCopy = await ok(client, "wallet_fetch_work", { intent, announcement: copy.announcement });
    expect(fromCopy).toMatchObject({ announcement: copy.announcement, worker: copier.address, first: { announcement: first.announcement, worker: worker.address } });
    h.specPages.set(url("own"), new TextEncoder().encode(work));
    expect(await ok(client, "wallet_fetch_work", { intent, announcement: own.announcement })).toMatchObject({ opens_commitment: false, next: WORK_DIFFERS });
    const release = { owner: wallet, nonce, delivered_sha256: sha256 };
    expect((await call(client, "wallet_attest", { ...release, pay_to: copier.address })).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: notEarliest(worker.address, sha256) });
    expect(await ok(client, "wallet_attest", release)).toMatchObject({ pay_to: worker.address, announcement: first.announcement, delivered_sha256: sha256, sent: false });
    const foreign = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: worker.address, spec_hash: "5c".repeat(32) }));
    expect(await ok(client, "wallet_check_delivery", { intent: foreign["intent"] })).toMatchObject({ intent: foreign["intent"], announcements: [] });
    expect((await call(client, "wallet_fetch_work", { intent: foreign["intent"] })).value).toMatchObject({ code: "WorkUnfetchable" });
    const plain = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: wallet }));
    expect((await call(client, "wallet_check_delivery", { intent: plain["intent"] })).value).toMatchObject({ code: "NotAProof" });
    expect((await call(client, "wallet_check_delivery", { intent: worker.address })).value).toMatchObject({ code: "NotFound" });
  });

  it("shows a worker its own announcements with how many came before, and passes over a blob that never opens", async () => {
    const { wallet, intent, nonce } = await judged();
    const griefer = await keyed();
    const grief = await griefed(intent, griefer, wallet, [wallet], "e7".repeat(32));
    const forger = await keyed();
    const forged = await griefed(intent, forger, wallet, [forger.address], "e7".repeat(32));
    const work = "e7".repeat(32);
    h.specPages.set(url("sealed.tar"), new TextEncoder().encode("ignored"));
    const own = await ok(client, "wallet_deliver", { intent, sha256: work, url: url("sealed.tar"), send: true });
    expect(own).toMatchObject({ seq: "3", sent: true });
    expect(await ok(client, "wallet_check_delivery", { intent })).toMatchObject({ mine: [{ announcement: own["announcement"], seq: "3", state: "announced", earlier: 2 }] });
    const plain = await connect(["mcp", "--url", "devnet"]);
    const outside = await ok(plain, "check_delivery", { intent });
    expect(outside).not.toHaveProperty("mine");
    expect(outside["announcements"]).toMatchObject([{ announcement: grief, worker: griefer.address }, { announcement: forged, worker: forger.address }, { announcement: own["announcement"], worker: wallet }]);
    const shown = await ok(client, "wallet_attest", { owner: wallet, nonce, delivered_sha256: work });
    expect(shown).toMatchObject({
      pay_to: wallet,
      announcement: own["announcement"],
      seq: "3",
      skipped: [
        { announcement: grief, seq: "1", worker: griefer.address, reason: "does-not-open", why: SKIP_REASONS["does-not-open"] },
        { announcement: forged, seq: "2", worker: forger.address, reason: "forged-wallet-slot", why: SKIP_REASONS["forged-wallet-slot"] },
      ],
    });
    expect(shown["summary"]).toContain(`Passes over: ${grief} (seq 1), ${SKIP_REASONS["does-not-open"]}`);
    expect(shown["summary"]).toContain(`Passes over: ${forged} (seq 2), ${SKIP_REASONS["forged-wallet-slot"]}`);
  });

  it("prepares an unsigned announcement for a worker that signs elsewhere", async () => {
    const judge = (await generateKeyPairSigner()).address;
    const { intent } = await judged(judge);
    const unproven = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: judge }));
    const plain = await connect(["mcp", "--url", "devnet"]);
    const worker = await funded();
    const work = "e7".repeat(32);
    const unsigned = { worker: worker.address, intent, sha256: work.toUpperCase(), url: url("work.tar") };
    const refused = (await call(plain, "prepare_deliver", unsigned)).value;
    expect(refused).toMatchObject({ code: "NoMessageSigner" });
    expect(refused["hint"]).toContain(Buffer.from(saltMessage(intent, work)).toString("hex"));
    const signed = Buffer.from(await signBytes(worker.keyPair.privateKey, saltMessage(intent, work))).toString("hex");
    const delivery = { ...unsigned, salt_signature: signed };
    const prepared = await ok(plain, "prepare_deliver", delivery);
    expect(prepared).toMatchObject({ intent, attestor: judge, sha256: work, url: delivery.url, sealed_to: [judge], sync_first: false, warnings: [ANNOUNCE_FIRST] });
    expect(prepared["summary"][0]).toContain(`binds it to ${worker.address} and a salt only its key derives`);
    const view = prepared["prepared"] as { transaction: string; signers: string[] };
    expect(view.signers).toEqual([worker.address]);
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(view.transaction));
    expect(Object.values(wire.signatures).every((signature) => signature === null)).toBe(true);
    expect((await call(plain, "prepare_deliver", { ...delivery, salt_signature: "zz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "salt_signature" }] });
    const stranger = await generateKeyPairSigner();
    const forged = Buffer.from(await signBytes(stranger.keyPair.privateKey, saltMessage(intent, work))).toString("hex");
    expect((await call(plain, "prepare_deliver", { ...delivery, salt_signature: forged })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "salt_signature" }] });
    expect(h.svm.sendTransaction(await partiallySignTransaction([worker.keyPair], wire))).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(h.svm.getAccount(prepared["announcement"] as Address).exists).toBe(true);
    expect((await call(plain, "prepare_deliver", { ...delivery, url: "ftp://" + "example.org/x" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "url" }] });
    expect((await call(plain, "prepare_deliver", { ...delivery, sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
    expect((await call(plain, "prepare_deliver", { ...delivery, intent: unproven["intent"] })).value).toMatchObject({ code: "NotDeliverable" });
    expect((await call(plain, "prepare_deliver", { intent, sha256: work, url: delivery.url })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "worker" }] });
  });
});

describe("planning an announcement", () => {
  it("names the field the SDK's InvalidInput names, not always the url", async () => {
    const worker = await generateKeyPairSigner();
    const intent = (await generateKeyPairSigner()).address;
    const ctx = { transport, relay: undefined, agent: undefined, claims: claimsOf() };
    const refused = (sha256: string, link: string) => planOf(ctx, { worker, intent, sha256, url: link }).catch((error: unknown) => error);
    expect(await refused("xyz", url("work.tar"))).toMatchObject({ name: "InvalidInput", issues: [{ path: "sha256" }] });
    expect(await refused("ab".repeat(32), "ftp://" + "example.org/x")).toMatchObject({ name: "InvalidInput", issues: [{ path: "url" }] });
  });
});
