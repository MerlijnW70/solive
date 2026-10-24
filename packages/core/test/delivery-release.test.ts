import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  announcementCommitment,
  attestedProofMessage,
  attestedSplitMessage,
  buildAnnounceDelivery,
  buildCancelIntent,
  buildCloseAnnouncement,
  buildCloseDeliveryBook,
  buildCommitteeBatch,
  buildEd25519CosignInstruction,
  buildCreateCommittee,
  buildFillAttested,
  buildFillAttestedCommittee,
  buildFillAttestedSplit,
  buildRefuteRelease,
  buildSetAnnounceFee,
  buildSyncCommitteeKeys,
  committeeProofDigest,
  deliveryBookAddress,
  INTENT_ENGINE_ERROR__ANNOUNCEMENT_OPEN,
  INTENT_ENGINE_ERROR__COMMITMENT_MISMATCH,
  INTENT_ENGINE_ERROR__DELIVERY_BOOK_OPEN,
  INTENT_ENGINE_ERROR__SIG_MESSAGE,
  refutationAddress,
  signCommitteeVote,
  signMessageBytes,
  signEd25519Instruction,
  splitCommit,
  splitFee,
  splitN,
} from "../src/index.js";
import { customCode, DOMAIN, emitted, Engine, ESCROW, FEE_BPS, named, NOW, sealedBlob, SPEC, TOKEN } from "./delivery-svm.js";

const DELIVERED = new Uint8Array(32).fill(0xd1);
const opened = (salt: number) => ({ delivered: DELIVERED, salt: new Uint8Array(16).fill(salt) });

type Announced = { announcement: Address; seq: bigint; opening: ReturnType<typeof opened> };

async function announce(e: Engine, worker: KeyPairSigner, intent: Address, attestor: Address, salt: number, committee = false): Promise<Announced> {
  const opening = opened(salt);
  const { announcement, instruction } = await buildAnnounceDelivery({
    worker,
    intent,
    attestor,
    committee,
    commitment: await announcementCommitment(intent, worker.address, opening),
    blob: sealedBlob(committee ? 3 : 1, salt),
  });
  await e.send(worker, [instruction]);
  return { announcement, seq: e.announcement(announcement).seq, opening };
}

function releaseTerms(intent: Address, a: Announced) {
  return { domain: DOMAIN, intent, amountIn: ESCROW, result: 1n, maxFeeBps: FEE_BPS, specHash: SPEC, announcement: a.announcement, seq: a.seq, ...a.opening };
}

const settleTerms = (intent: Address, payee: Address, a: Announced) => ({ ...releaseTerms(intent, a), payee });

async function judgeFill(e: Engine, owner: Address, worker: KeyPairSigner, payee: Address, a: Announced) {
  return buildFillAttested({
    solver: worker,
    owner,
    nonce: 0n,
    inputMint: e.inputMint,
    inputTokenProgram: TOKEN,
    payee,
    feeRecipient: e.feeRecipient.address,
    amountIn: ESCROW,
    result: 1n,
    maxFeeBps: FEE_BPS,
    announcement: a.announcement,
    opening: a.opening,
  });
}

describe("delivery v4 against the deployed engine, built only from the core builders", () => {
  it("announces for a proof escrow and settles it on the judge's signature over the delivery preimage", async () => {
    const e = await Engine.start();
    const [owner, judge, worker] = [await e.funded(), await e.funded(), await e.funded()];
    const intent = await e.proofEscrow(owner, judge.address);
    const payee = await e.ata(worker.address);
    await e.ata(e.feeRecipient.address);
    const feeSet = await e.send(e.authority, [await buildSetAnnounceFee({ admin: e.authority, fee: 5_000 })]);
    expect(emitted(feeSet)).toEqual([{ name: "AnnounceFeeSet", notable: true, fields: { fee: 5_000 } }]);
    const opening = opened(0x5a);
    const { announcement, instruction } = await buildAnnounceDelivery({
      worker,
      intent,
      attestor: judge.address,
      feeRecipient: e.feeRecipient.address,
      commitment: await announcementCommitment(intent, worker.address, opening),
      blob: sealedBlob(1, 0x5a),
    });
    const before = e.lamportsOf(e.feeRecipient.address);
    const made = await e.send(worker, [instruction]);
    expect(e.lamportsOf(e.feeRecipient.address) - before).toBe(5_000n);
    expect(named(emitted(made), "DeliveryAnnounced")).toMatchObject({ intent, announcement, seq: 1n, worker: worker.address, attestor: judge.address, recipients: 1 });
    const a = { announcement, seq: e.announcement(announcement).seq, opening };
    const terms = settleTerms(intent, payee, a);
    const fill = await judgeFill(e, owner.address, worker, payee, a);
    const swaps = [
      { intent: payee, payee: intent },
      { amountIn: 1n, result: ESCROW },
      { announcement: payee, payee: announcement },
    ];
    for (const swapped of swaps) {
      const forged = await signEd25519Instruction(judge, await attestedProofMessage(judge.address, { ...terms, ...swapped }));
      expect(customCode(await e.attempt(worker, [forged, fill]))).toBe(INTENT_ENGINE_ERROR__SIG_MESSAGE);
    }
    const signed = await signEd25519Instruction(judge, await attestedProofMessage(judge.address, terms));
    const released = await e.send(worker, [signed, fill]);
    expect(named(emitted(released), "DeliveryReleased")).toEqual({
      intent,
      announcement,
      seq: 1n,
      worker: worker.address,
      attestor: judge.address,
      delivered: DELIVERED,
      salt: opening.salt,
      splitHash: new Uint8Array(32),
    });
    const paid = e.announcement(announcement);
    expect({ state: paid.state, delivered: paid.delivered, salt: paid.salt, paidAt: paid.paidAt }).toEqual({ state: 1, delivered: DELIVERED, salt: opening.salt, paidAt: NOW });
    expect(e.balance(payee)).toBe(splitFee(ESCROW, FEE_BPS).net);
  });

  it("settles a committee escrow on member votes over the committee digest of the delivery preimage", async () => {
    const e = await Engine.start();
    const [owner, worker] = [await e.funded(), await e.funded()];
    const signers = [await e.funded(), await e.funded(), await e.funded()];
    const { committee, instruction } = await buildCreateCommittee({ payer: e.authority, members: signers.map((s) => s.address), threshold: 2, feeWallet: e.feeRecipient.address });
    await e.send(e.authority, [instruction]);
    const synced = await e.send(e.authority, [await buildSyncCommitteeKeys({ committee: committee.address, members: [...committee.members].reverse() })]);
    expect(named(emitted(synced), "CommitteeKeysSynced")).toMatchObject({ committee: committee.address, mask: 0 });
    const intent = await e.proofEscrow(owner, committee.address, committee.address);
    const payee = await e.ata(worker.address);
    await e.ata(e.feeRecipient.address);
    const a = await announce(e, worker, intent, committee.address, 0x33, true);
    const digest = await committeeProofDigest(settleTerms(intent, payee, a));
    const voters = signers.filter((s) => s.address !== committee.members[1]);
    const votes = await Promise.all(voters.map((member) => signCommitteeVote(member, digest, committee.members)));
    const { instruction: batch, mask } = buildCommitteeBatch(committee, digest, votes);
    const fill = await buildFillAttestedCommittee({
      solver: worker,
      owner: owner.address,
      nonce: 0n,
      inputMint: e.inputMint,
      inputTokenProgram: TOKEN,
      payee,
      feeRecipient: e.feeRecipient.address,
      amountIn: ESCROW,
      result: 1n,
      maxFeeBps: FEE_BPS,
      committee: committee.address,
      signers: mask,
      announcement: a.announcement,
      opening: a.opening,
    });
    const released = await e.send(worker, [batch, fill]);
    expect(named(emitted(released), "DeliveryReleased")).toMatchObject({ intent, announcement: a.announcement, seq: a.seq, worker: worker.address, attestor: committee.address });
    expect(e.announcement(a.announcement).state).toBe(1);
    expect(e.balance(payee)).toBe(splitFee(ESCROW, FEE_BPS).net);
  });

  it("splits a proof escrow between the announcer and a co-author on cosignatures over the split delivery preimage", async () => {
    const e = await Engine.start();
    const [owner, judge, worker, coauthor] = [await e.funded(), await e.funded(), await e.funded(), await e.funded()];
    const intent = await e.proofEscrow(owner, judge.address);
    const accounts = [await e.ata(worker.address), await e.ata(coauthor.address)];
    await e.ata(e.feeRecipient.address);
    const a = await announce(e, worker, intent, judge.address, 0x44);
    const recipients = [worker.address, coauthor.address];
    const weights = [7_000, 3_000];
    const terms = { ...releaseTerms(intent, a), splitHash: await splitCommit(recipients, weights) };
    const cosigners = [worker, coauthor, judge];
    const message = await attestedSplitMessage(terms, cosigners.map((s) => s.address));
    const entries = await Promise.all(cosigners.map(async (s) => ({ publicKey: s.address, signature: await signMessageBytes(s, message) })));
    const fill = await buildFillAttestedSplit({
      solver: worker,
      owner: owner.address,
      nonce: 0n,
      inputMint: e.inputMint,
      inputTokenProgram: TOKEN,
      feeRecipient: e.feeRecipient.address,
      amountIn: ESCROW,
      result: 1n,
      maxFeeBps: FEE_BPS,
      recipients,
      weights,
      announcement: a.announcement,
      opening: a.opening,
    });
    const swapped = await attestedSplitMessage({ ...terms, amountIn: 1n, result: ESCROW }, cosigners.map((s) => s.address));
    const forged = await Promise.all(cosigners.map(async (s) => ({ publicKey: s.address, signature: await signMessageBytes(s, swapped) })));
    expect(customCode(await e.attempt(worker, [buildEd25519CosignInstruction({ entries: forged, message: swapped }), fill]))).toBe(INTENT_ENGINE_ERROR__SIG_MESSAGE);
    const released = await e.send(worker, [buildEd25519CosignInstruction({ entries, message }), fill]);
    expect(named(emitted(released), "DeliveryReleased")).toMatchObject({ announcement: a.announcement, worker: worker.address, splitHash: terms.splitHash });
    expect(e.announcement(a.announcement).splitHash).toEqual(terms.splitHash);
    const net = splitFee(ESCROW, FEE_BPS).net;
    expect(accounts.map((account) => e.balance(account))).toEqual(splitN(net, weights));
  });

  it("lets an earlier announcer record that the judge paid a later announcer for the same delivery", async () => {
    const e = await Engine.start();
    const [owner, judge, early, late] = [await e.funded(), await e.funded(), await e.funded(), await e.funded()];
    const intent = await e.proofEscrow(owner, judge.address);
    const payee = await e.ata(late.address);
    await e.ata(e.feeRecipient.address);
    const first = await announce(e, early, intent, judge.address, 0x01);
    const second = await announce(e, late, intent, judge.address, 0x02);
    expect([first.seq, second.seq]).toEqual([1n, 2n]);
    const signed = await signEd25519Instruction(judge, await attestedProofMessage(judge.address, settleTerms(intent, payee, second)));
    await e.send(late, [signed, await judgeFill(e, owner.address, late, payee, second)]);
    const esk = new Uint8Array(32).fill(0x45);
    const refute = (salt: Uint8Array) => buildRefuteRelease({ earlierWorker: early, paid: second.announcement, earlier: first.announcement, salt, esk });
    expect(customCode(await e.attempt(early, [await refute(second.opening.salt)]))).toBe(INTENT_ENGINE_ERROR__COMMITMENT_MISMATCH);
    const refuted = await e.send(early, [await refute(first.opening.salt)]);
    const refutation = await refutationAddress(first.announcement);
    expect(named(emitted(refuted), "ReleaseRefuted")).toEqual({
      intent,
      attestor: judge.address,
      refutation,
      paidAnnouncement: second.announcement,
      paidSeq: 2n,
      paidWorker: late.address,
      earlierAnnouncement: first.announcement,
      earlierSeq: 1n,
      earlierWorker: early.address,
      delivered: DELIVERED,
      refuter: early.address,
    });
    expect(e.exists(refutation)).toBe(true);
  });

  it("returns the announcement and the delivery book rent once the escrow is cancelled", async () => {
    const e = await Engine.start();
    const [owner, judge, worker] = [await e.funded(), await e.funded(), await e.funded()];
    const intent = await e.proofEscrow(owner, judge.address);
    const a = await announce(e, worker, intent, judge.address, 0x77);
    const book = await deliveryBookAddress(intent);
    const closeAnnouncement = await buildCloseAnnouncement({ by: worker, announcement: a.announcement, intent, rentTo: worker.address });
    const closeBook = await buildCloseDeliveryBook({ by: owner, intent, rentTo: worker.address });
    expect(customCode(await e.attempt(e.authority, [closeAnnouncement]))).toBe(INTENT_ENGINE_ERROR__ANNOUNCEMENT_OPEN);
    expect(customCode(await e.attempt(e.authority, [closeBook]))).toBe(INTENT_ENGINE_ERROR__DELIVERY_BOOK_OPEN);
    await e.send(owner, [await buildCancelIntent({ owner, nonce: 0n, inputMint: e.inputMint, tokenProgram: TOKEN })]);
    const [announcementRent, bookRent, before] = [e.lamportsOf(a.announcement), e.lamportsOf(book), e.lamportsOf(worker.address)];
    const closed = await e.send(e.authority, [closeAnnouncement]);
    expect(named(emitted(closed), "AnnouncementClosed")).toEqual({
      intent,
      announcement: a.announcement,
      seq: 1n,
      worker: worker.address,
      rentTo: worker.address,
      lamports: announcementRent,
      by: worker.address,
    });
    const emptied = await e.send(e.authority, [closeBook]);
    expect(named(emitted(emptied), "DeliveryBookClosed")).toEqual({ intent, book, nextSeq: 2n, rentTo: worker.address, lamports: bookRent, by: owner.address });
    expect([e.exists(a.announcement), e.exists(book)]).toEqual([false, false]);
    expect(e.lamportsOf(worker.address) - before).toBe(announcementRent + bookRent);
  });
});
