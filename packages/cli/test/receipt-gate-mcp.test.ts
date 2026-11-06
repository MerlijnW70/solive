import { rm } from "node:fs/promises";
import { type Address, generateKeyPairSigner, getBase16Decoder } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentStatus } from "@intent-engine/core";
import { getIntentDecoder, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { RELEASE_CHANGED, VOTE_CHANGED } from "../src/agent/wallet.js";
import { EMPTY_REASON } from "../src/receipt-gate.js";
import { EXIT_OK } from "../src/main.js";
import { call, fresh, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { cli, funded, h, HOME, transport } from "./harness.js";
import { receiptPath } from "../src/judge-receipt.js";
import { approved } from "./approved.js";
import { judgedBy } from "./receipt-kit.js";

const SPEC = "5c".repeat(32);
const WORK = "e7".repeat(32);
const REASON = "the hirer checked this work by hand";

const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

describe("the judge receipt gate on the wallet server", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  async function proofJob(attestor?: Address) {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: attestor ?? wallet, spec_hash: SPEC }));
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    const [worker, copier] = [await keyed(), await keyed()];
    const first = await announced(intent, worker, WORK);
    const copy = await announced(intent, copier, WORK);
    const at = { owner: wallet, nonce: BigInt(nonce), intent, specSha256: SPEC, deliveredSha256: WORK, announcement: first.announcement };
    return { wallet, intent, nonce, worker, copier, first, copy, at, release: { owner: wallet, nonce, delivered_sha256: WORK } };
  }

  it("refuses a proof release without a receipt at preview and at send, naming how to get one, and sends nothing", async () => {
    const job = await proofJob();
    const preview = await call(client, "wallet_attest", job.release);
    expect(preview).toMatchObject({ error: true, value: { code: "NoJudgeReceipt", retryable: false } });
    expect(String(preview.value["hint"])).toContain(tool("wallet_judge_work"));
    expect(String(preview.value["hint"])).toContain("without_receipt");
    const send = await call(client, "wallet_attest", { ...job.release, approval: "0".repeat(16), send: true });
    expect(send.value).toMatchObject({ code: "NoJudgeReceipt" });
    expect(statusOf(job.intent)).toBe(IntentStatus.Open);
  });

  it("pays only with a receipt for this escrow, spec, work, first announcement, judge and cluster", async () => {
    const job = await proofJob();
    const other = (await generateKeyPairSigner()).address;
    const wrong = [
      { ...job.at, intent: other },
      { ...job.at, specSha256: "6d".repeat(32) },
      { ...job.at, deliveredSha256: "e8".repeat(32) },
      { ...job.at, announcement: job.copy.announcement },
      { ...job.at, nonce: job.at.nonce + 1n },
      { ...job.at, owner: other },
    ];
    for (const at of wrong) {
      await judgedBy([job.wallet], at);
    }
    await judgedBy([other], job.at);
    const refused = await call(client, "wallet_attest", job.release);
    expect(refused.value).toMatchObject({ code: "NoJudgeReceipt" });
    await judgedBy([job.wallet], job.at);
    const shown = await ok(client, "wallet_attest", job.release);
    expect(shown).not.toHaveProperty("unchecked");
    expect(await ok(client, "wallet_attest", { ...job.release, approval: shown["approval"], send: true })).toMatchObject({ sent: true, pay_to: job.worker.address });
    expect(statusOf(job.intent)).not.toBe(IntentStatus.Open);
  });

  it("signs without a receipt only with a named reason, records it, and refuses the override added or dropped between preview and send", async () => {
    const job = await proofJob();
    expect((await call(client, "wallet_attest", { ...job.release, without_receipt: "   " })).value).toMatchObject({ code: "NoJudgeReceipt", hint: expect.stringContaining(EMPTY_REASON) });
    const plain = await ok(client, "wallet_attest", { ...job.release, without_receipt: REASON });
    expect(plain["unchecked"]).toEqual({ reason: REASON, warning: expect.stringContaining(`the work with sha256 ${WORK}`) });
    expect(plain["unchecked"]["warning"]).toContain("signed without a judge receipt");
    const dropped = await call(client, "wallet_attest", { ...job.release, approval: plain["approval"], send: true });
    expect(dropped.value).toMatchObject({ code: "NoJudgeReceipt" });
    await judgedBy([job.wallet], job.at);
    const judged = await ok(client, "wallet_attest", job.release);
    expect(judged["approval"]).not.toBe(plain["approval"]);
    expect((await call(client, "wallet_attest", { ...job.release, approval: plain["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: RELEASE_CHANGED });
    expect((await call(client, "wallet_attest", { ...job.release, without_receipt: REASON, approval: judged["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect((await call(client, "wallet_attest", { ...job.release, without_receipt: "another reason", approval: plain["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect(statusOf(job.intent)).toBe(IntentStatus.Open);
    const sent = await ok(client, "wallet_attest", { ...job.release, without_receipt: REASON, approval: plain["approval"], send: true });
    expect(sent).toMatchObject({ sent: true, unchecked: { reason: REASON } });
  });

  it("gates a split release as its judge the same way", async () => {
    const job = await proofJob();
    const recipients = [{ wallet: job.worker.address, weight: 5000 }, { wallet: (await funded()).address, weight: 5000 }];
    const split = { ...job.release, recipients };
    expect((await call(client, "wallet_attest_split", split)).value).toMatchObject({ code: "NoJudgeReceipt" });
    expect(await ok(client, "wallet_attest_split", { ...split, without_receipt: REASON })).toMatchObject({ sent: false, unchecked: { reason: REASON } });
    await judgedBy([job.wallet], job.at);
    expect(await ok(client, "wallet_attest_split", split)).not.toHaveProperty("unchecked");
  });

  it("gates a committee member's own vote on its own receipt, and relays the votes in a release without any receipt or override", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const other = await funded();
    const payer = await funded();
    const members = sortMembers([wallet, other.address]);
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const job = await proofJob(created.json()["committee"] as Address);
    const ballot = { owner: job.wallet, nonce: job.nonce, result: "1", delivered_sha256: WORK };
    const recipients = [{ wallet: job.worker.address, weight: 6000 }, { wallet: other.address, weight: 4000 }];
    const forged = [{ member: other.address, signature: "ab".repeat(64) }, { member: job.wallet, signature: "cd".repeat(64) }];
    const relayed = await call(client, "wallet_committee_release", { ...ballot, votes: forged });
    expect([relayed.error, relayed.value["code"]]).toEqual([true, "SigMessage"]);
    await judgedBy([other.address], job.at);
    for (const args of [ballot, { ...ballot, recipients }]) {
      expect((await call(client, "wallet_committee_vote", args)).value).toMatchObject({ code: "NoJudgeReceipt", hint: expect.stringContaining(`a judge run of ${job.wallet}`) });
    }
    const unchecked = await ok(client, "wallet_committee_vote", { ...ballot, without_receipt: REASON });
    expect(unchecked).toMatchObject({ signed: false, unchecked: { reason: REASON } });
    expect((await call(client, "wallet_committee_vote", { ...ballot, approval: unchecked["approval"], send: true })).value).toMatchObject({ code: "NoJudgeReceipt" });
    await judgedBy([job.wallet], job.at);
    const shown = await ok(client, "wallet_committee_vote", ballot);
    expect(shown).not.toHaveProperty("unchecked");
    expect((await call(client, "wallet_committee_vote", { ...ballot, approval: unchecked["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: VOTE_CHANGED });
    const own = (await ok(client, "wallet_committee_vote", { ...ballot, approval: shown["approval"], send: true }))["vote"] as { member: Address; signature: string };
    expect(await ok(client, "wallet_committee_vote", { ...ballot, recipients })).toMatchObject({ signed: false });
    const digest = await createClient({ url: "http://cluster", transport }).committeeBallot({
      intent: { owner: job.wallet, nonce: BigInt(job.nonce) },
      announcement: job.first.announcement,
      opening: { sha256: WORK, salt: job.first.salt },
      result: 1n,
    });
    const theirs = await signCommitteeVote(other, digest.digest, digest.committee.members);
    const votes = [own, { member: theirs.member, signature: getBase16Decoder().decode(theirs.signature).toLowerCase() }];
    const cluster = await transport.genesisHash();
    for (const judge of [job.wallet, other.address]) {
      await rm(receiptPath(HOME, { cluster, judge, intent: job.intent, announcement: job.first.announcement, deliveredSha256: WORK }), { force: true });
    }
    const preview = await ok(client, "wallet_committee_release", { ...ballot, votes });
    expect(preview).not.toHaveProperty("unchecked");
    expect(await ok(client, "wallet_committee_release", { ...ballot, votes, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
    expect(statusOf(job.intent)).toBe(IntentStatus.Filled);
  });
});
