import { type Address, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildClaimJob, buildOpenClaims, deliveryBookAddress, getDeliveryBookSize, signCommitteeVote, sortMembers, V1_BOOK_SPACE } from "@intent-engine/core/internal";
import { CancelNotReady, connect, createClient, NotSettleable, VoteRejected } from "../src/index.js";
import { announceProtection, loadDeliveryBook, NOTICE_SECS, tooLateToArm } from "../src/internal.js";
import { passNotice } from "./notice.js";
import { onDevnet, world } from "./svm.js";
import { announced, fundedSigner, LOCAL, nativeMint, sha, specHash } from "./work.js";

const STAKE = 1_000_000n;
const REVIEW = 7_200;
const WORK = sha("the reviewed work");
const DAY = 86_400n;

async function job(attestor?: Address, claims = true) {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const [owner, judge, worker] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
  const params = { kind: Kind.AttestedResult, amountIn: 10_000n, minResult: 1n, maxResult: 1n, attestor: attestor ?? judge.address, specHash: specHash("the fair spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint, expiresIn: 3n * DAY });
  const intent = made.intent;
  if (claims) {
    await client.send([await buildOpenClaims({ owner, intent, maxSecs: 3_600, stake: STAKE, reviewSecs: REVIEW, killFee: STAKE })], owner);
  }
  const claim = async (by: KeyPairSigner = worker) => client.send([await buildClaimJob({ worker: by, intent, owner: owner.address, secs: 600 })], by);
  const balance = (wallet: Address): bigint => w.chain.svm.getBalance(wallet) ?? 0n;
  return { w, client, owner, judge, worker, intent, ref: { owner: owner.address, nonce: made.nonce }, claim, balance };
}

describe("fair closing through the SDK", () => {
  it("arms a review for the holder's first announcement, refuses the cancel while it runs, and says so before sending", async () => {
    const s = await job();
    await s.claim();
    const plan = await s.client.plan.announce({ worker: s.worker, intent: s.intent, sha256: WORK, url: "https://" + "example.org/w" });
    expect(plan.protection).toMatchObject({ arms: true, reviewSecs: REVIEW, killFee: STAKE, why: null });
    const made = await announced(s.client, s.worker, s.intent, WORK);
    const claims = await s.client.claims(s.ref);
    expect(claims?.review).toMatchObject({ announcement: made.announcement, lapsed: false });
    expect(await s.client.cancelState(s.ref)).toMatchObject({ stage: "request", announced: true });
    await expect(s.client.cancel(s.owner, s.ref)).rejects.toBeInstanceOf(CancelNotReady);
    await s.client.requestCancel(s.owner, s.ref);
    const asked = await s.client.cancelState(s.ref);
    expect(asked).toMatchObject({ stage: "notice", secondsLeft: NOTICE_SECS });
    await expect(s.client.requestCancel(s.owner, s.ref)).rejects.toMatchObject({ code: "cancel-not-ready", stage: "notice" });
    const rival = await fundedSigner(s.w);
    const late = await s.client.plan.announce({ worker: rival, intent: s.intent, sha256: sha("other"), url: "https://" + "example.org/o" }).catch((error: unknown) => error);
    expect(late).toMatchObject({ code: "not-deliverable", reason: "claim-held" });
  });

  it("lets the judge reject in time, returning the holder's stake and leaving the kill fee with the owner", async () => {
    const s = await job();
    await s.claim();
    const made = await announced(s.client, s.worker, s.intent, WORK);
    const ballot = await s.client.rejectBallot({ intent: s.intent, announcement: made.announcement });
    expect(ballot).toMatchObject({ worker: s.worker.address, attestor: s.judge.address, committee: null, review: { lapsed: false } });
    await expect(s.client.reject({ judge: s.worker, intent: s.intent, announcement: made.announcement })).rejects.toMatchObject({ reason: "wrong-judge" });
    const before = s.balance(s.worker.address);
    await s.client.reject({ judge: s.judge, payer: s.owner, intent: s.intent, announcement: made.announcement });
    expect(s.balance(s.worker.address) - before).toBe(STAKE);
    expect((await s.client.announcements(s.intent)).announcements.map(({ state }) => state)).toEqual(["rejected"]);
    expect(await s.client.claims(s.ref)).toMatchObject({ state: "free", review: null, killFee: STAKE });
    await expect(s.client.rejectBallot({ intent: s.intent, announcement: made.announcement })).rejects.toBeInstanceOf(NotSettleable);
  });

  it("pays the holder its stake and the kill fee once the review lapses, and refuses a reject or an early collect", async () => {
    const s = await job();
    await s.claim();
    const made = await announced(s.client, s.worker, s.intent, WORK);
    await expect(s.client.collect(s.owner, s.ref)).rejects.toMatchObject({ reason: "review-running" });
    passNotice(s.w.chain.svm, BigInt(REVIEW));
    await expect(s.client.rejectBallot({ intent: s.intent, announcement: made.announcement })).rejects.toMatchObject({ reason: "review-lapsed" });
    const plan = await s.client.plan.collect(s.owner, s.ref);
    expect(plan).toMatchObject({ worker: s.worker.address, stake: STAKE, killFee: STAKE, announcement: made.announcement });
    const before = s.balance(s.worker.address);
    await s.client.collect(s.owner, s.ref);
    expect(s.balance(s.worker.address) - before).toBe(2n * STAKE);
    expect(await s.client.claims(s.ref)).toMatchObject({ state: "free", review: null, killFee: 0n });
    await expect(s.client.collect(s.owner, s.ref)).rejects.toMatchObject({ reason: "no-review" });
  });

  it("waits for the later of the notice and the review, then cancels and pays a lapsed holder", async () => {
    const s = await job();
    const junk = await fundedSigner(s.w);
    await announced(s.client, junk, s.intent, sha("junk"));
    await s.client.requestCancel(s.owner, s.ref);
    passNotice(s.w.chain.svm, DAY - 4_000n);
    await s.claim();
    await announced(s.client, s.worker, s.intent, WORK);
    passNotice(s.w.chain.svm, 4_000n);
    const state = await s.client.cancelState(s.ref);
    expect(state).toMatchObject({ stage: "review" });
    await expect(s.client.cancel(s.owner, s.ref)).rejects.toMatchObject({ stage: "review" });
    passNotice(s.w.chain.svm, state.secondsLeft);
    const before = s.balance(s.worker.address);
    await s.client.cancel(s.owner, s.ref);
    expect(s.balance(s.worker.address) - before).toBe(2n * STAKE);
    expect((await s.client.intent(s.ref))?.intent.status).toBe(IntentStatus.Cancelled);
  });

  it("cancels at once an escrow nobody announced to", async () => {
    const s = await job(undefined, false);
    expect(await s.client.cancelState(s.ref)).toMatchObject({ stage: "now", announced: false });
    await expect(s.client.requestCancel(s.owner, s.ref)).rejects.toBeInstanceOf(CancelNotReady);
    await s.client.cancel(s.owner, s.ref);
    expect((await s.client.intent(s.ref))?.intent.status).toBe(IntentStatus.Cancelled);
  });

  it("reads a version 1 delivery book and migrates it within the cancel request", async () => {
    const s = await job(undefined, false);
    await announced(s.client, s.worker, s.intent, WORK);
    const book = await deliveryBookAddress(s.intent);
    const view = s.w.chain.svm.getAccount(book);
    if (!view.exists) {
      throw new Error("no book");
    }
    const data = Uint8Array.from(view.data).slice(0, V1_BOOK_SPACE);
    data[8 + 80] = 1;
    s.w.chain.svm.setAccount({ ...view, data, space: BigInt(V1_BOOK_SPACE) });
    expect(await loadDeliveryBook(s.w.chain.transport, s.intent)).toMatchObject({ live: 1n, cancelAt: 0n });
    expect(await s.client.cancelState(s.ref)).toMatchObject({ stage: "request", migrates: true });
    await s.client.requestCancel(s.owner, s.ref);
    const migrated = s.w.chain.svm.getAccount(book);
    expect(migrated.exists ? migrated.data.length : 0).toBe(getDeliveryBookSize());
    passNotice(s.w.chain.svm);
    await s.client.cancel(s.owner, s.ref);
    expect((await s.client.intent(s.ref))?.intent.status).toBe(IntentStatus.Cancelled);
  });

  it("rejects for a committee only on a quorum of member votes over the reject ballot", async () => {
    const w0 = await world();
    nativeMint(w0);
    const setupClient = createClient({ url: LOCAL, transport: w0.chain.transport });
    const members = await Promise.all([0, 1, 2].map(() => fundedSigner(w0)));
    const creator = await fundedSigner(w0);
    const { committee } = await setupClient.createCommittee({ payer: creator, members: members.map(({ address }) => address), threshold: 2, feeWallet: creator.address });
    const owner = await fundedSigner(w0);
    const params = { kind: Kind.AttestedResult, amountIn: 10_000n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the fair spec"), judgeFee: 0n } as const;
    const { intent } = await setupClient.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w0.outputMint, expiresIn: 3n * DAY });
    const made = await announced(setupClient, await fundedSigner(w0), intent, WORK);
    const ballot = await setupClient.rejectBallot({ intent, announcement: made.announcement });
    const sorted = sortMembers(members.map(({ address }) => address));
    expect(ballot.committee?.members).toEqual(sorted);
    const votes = await Promise.all(members.map((member) => signCommitteeVote(member, ballot.digest, sorted)));
    await expect(setupClient.rejectCommittee({ relayer: creator, intent, announcement: made.announcement, votes: votes.slice(0, 1) })).rejects.toMatchObject({ field: "votes" });
    const forged = { member: votes[0]?.member as Address, signature: votes[1]?.signature ?? new Uint8Array(64) };
    await expect(setupClient.rejectCommittee({ relayer: creator, intent, announcement: made.announcement, votes: [forged, votes[2] as (typeof votes)[number]] })).rejects.toBeInstanceOf(VoteRejected);
    await expect(setupClient.reject({ judge: members[0] as KeyPairSigner, intent, announcement: made.announcement })).rejects.toMatchObject({ reason: "committee-judged" });
    await setupClient.rejectCommittee({ relayer: creator, intent, announcement: made.announcement, votes: votes.slice(1) });
    expect((await setupClient.announcements(intent)).announcements.map(({ state }) => state)).toEqual(["rejected"]);
  });

  it("cancels through the simple client in two sends, the first requesting the cancel", async () => {
    const s = await job(undefined, false);
    await announced(s.client, s.worker, s.intent, WORK);
    const simple = await connect({ cluster: "devnet", signer: s.owner, transport: onDevnet(s.w.chain.transport) });
    expect((await simple.cancel({ escrow: s.intent, preview: true })).summary).toContain(`Request a cancel of ${s.intent}`);
    await simple.cancel({ escrow: s.intent });
    expect((await loadDeliveryBook(s.w.chain.transport, s.intent))?.cancelAt).toBe(s.w.test.now() + NOTICE_SECS);
    await expect(simple.cancel({ escrow: s.intent })).rejects.toMatchObject({ code: "cancel-not-ready", stage: "notice" });
    passNotice(s.w.chain.svm);
    await simple.cancel({ escrow: s.intent });
    expect((await s.client.intent(s.ref))?.intent.status).toBe(IntentStatus.Cancelled);
  });

  it("shows the simple deliver's protection in its summary", async () => {
    const s = await job();
    await s.claim();
    const simple = await connect({ cluster: "devnet", signer: s.worker, transport: onDevnet(s.w.chain.transport) });
    const shown = await simple.deliver({ escrow: s.intent, sha256: WORK, url: "https://" + "example.org/w", preview: true });
    expect(shown.summary).toContain(`; Protected: this announcement arms a review until ${s.w.test.now() + BigInt(REVIEW)}`);
  });

  it("refuses an unprotected announcement once a requested cancel can land, unless forced", async () => {
    const s = await job(undefined, false);
    await announced(s.client, s.worker, s.intent, WORK);
    await s.client.requestCancel(s.owner, s.ref);
    const late = await fundedSigner(s.w);
    const work = { worker: late, intent: s.intent, sha256: sha("late"), url: "https://" + "example.org/l" };
    expect((await s.client.plan.announce(work)).protection).toMatchObject({ arms: false, cancelAt: s.w.test.now() + NOTICE_SECS });
    passNotice(s.w.chain.svm);
    await expect(s.client.plan.announce(work)).rejects.toMatchObject({ code: "not-deliverable", reason: "cancel-due" });
    expect((await s.client.plan.announce({ ...work, force: true })).instructions.length).toBeGreaterThan(0);
  });

  it("arms no review for an announcement made after the last time the whole window fits", () => {
    const worker = "So11111111111111111111111111111111111111112" as Address;
    const board = { reviewSecs: REVIEW, killFee: STAKE, stake: STAKE, reviewUntil: 0n, reviewAnn: "11111111111111111111111111111111" as Address, worker, until: 20_000n };
    expect(announceProtection(board, worker, 10_000n, 10_000n - BigInt(REVIEW), null)).toMatchObject({ arms: true, reviewUntil: 10_000n });
    expect(announceProtection(board, worker, 10_000n, 10_001n - BigInt(REVIEW), null)).toMatchObject({ arms: false, why: tooLateToArm(10_000n - BigInt(REVIEW), REVIEW) });
  });
});