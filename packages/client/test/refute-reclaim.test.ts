import { type Address, type TransactionSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { buildCloseAnnouncement, deliveryBookAddress, refutationAddress, signMessageBytes, splitN } from "@intent-engine/core/internal";
import { BookNotClosable, connect, CosignRejected, createClient, NotRefutable, NotSettleable } from "../src/index.js";
import { budgeted, PACKET_DATA_SIZE, RECLAIM_BATCH, transactionBytes } from "../src/internal.js";
import { FEE_BPS, world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the refuted work");
const PAY = 1_000_000n;

async function job() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, judge, owner, intent: made.intent, nonce: made.nonce };
}

describe("refuting, reclaiming and closing", () => {
  it("lets an earlier worker record on chain that the judge paid a later announcement of the same work", async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
    const paid = await announced(client, late, intent, WORK);
    const refute = { worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") };
    await expect(client.refute(refute)).rejects.toThrow(NotRefutable);
    await expect(client.refute(refute)).rejects.toThrow("which was never paid");
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...paid, result: 1n });
    const sent = w.chain.sent.length;
    await expect(client.refute({ ...refute, url: workUrl("other.tar") })).rejects.toThrow("does not open with the url");
    await expect(client.refute({ ...refute, sha256: sha("other") })).rejects.toThrow(`paid the work ${WORK}`);
    await expect(client.refute({ ...refute, worker: late })).rejects.toThrow(`was made by ${early.address}`);
    await expect(client.refute({ ...refute, worker: late, earlier: paid.announcement, paid: paid.announcement })).rejects.toThrow("RefuteNotEarlier");
    expect(w.chain.sent).toHaveLength(sent);
    const refuted = await client.refute(refute);
    expect(refuted.refutation).toBe(await refutationAddress(earlier.announcement));
    expect(w.chain.sent).toContain(refuted.signature);
    const buyer = await connect({ cluster: "devnet", signer: owner, transport: w.chain.transport });
    expect(await buyer.receipt({ escrow: intent })).toMatchObject({ payee: late.address, deliveredSha256: WORK, valid: true, refutedBy: refuted.refutation, complete: true });
    expect(await client.reputation(late.address)).toMatchObject({ refuted: 1, paid: 0 });
  });

  it("reclaims every announcement the program lets its worker close now, then anyone closes the empty book", async () => {
    const { w, client, owner, intent, nonce } = await job();
    const [worker, relayer] = [await fundedSigner(w), await fundedSigner(w)];
    const own = await announced(client, worker, intent, WORK);
    const relayed = await client.announce({ worker, payer: relayer, intent, sha256: WORK, url: workUrl("relayed.tar") });
    expect(await client.reclaim({ worker })).toEqual({ closed: [], kept: [own.announcement, relayed.announcement], signatures: [] });
    await expect(client.closeBook(intent, owner)).rejects.toThrow(BookNotClosable);
    await client.cancel(owner, { owner: owner.address, nonce });
    await expect(client.closeBook(intent, owner)).rejects.toThrow("still holds 2 announcements");
    const [workerBefore, relayerBefore] = [w.chain.svm.getBalance(worker.address) ?? 0n, w.chain.svm.getBalance(relayer.address) ?? 0n];
    const rent = w.chain.svm.getBalance(relayed.announcement) ?? 0n;
    const reclaimed = await client.reclaim({ worker, payer: relayer });
    expect(reclaimed.closed).toEqual([own.announcement, relayed.announcement]);
    expect(reclaimed.signatures).toHaveLength(1);
    expect((await client.announcements(intent)).announcements).toEqual([]);
    expect((w.chain.svm.getBalance(worker.address) ?? 0n) - workerBefore).toBe(rent);
    expect((w.chain.svm.getBalance(relayer.address) ?? 0n) - relayerBefore).toBeGreaterThan(0n);
    const book = await deliveryBookAddress(intent);
    const bookRent = w.chain.svm.getBalance(book) ?? 0n;
    const stranger: TransactionSigner = await fundedSigner(w);
    const workerBeforeBook = w.chain.svm.getBalance(worker.address) ?? 0n;
    await client.closeBook(intent, stranger);
    expect(w.chain.svm.getAccount(book).exists).toBe(false);
    expect((w.chain.svm.getBalance(worker.address) ?? 0n) - workerBeforeBook).toBe(bookRent);
    await expect(client.closeBook(intent, stranger)).rejects.toThrow("does not exist");
  });

  it("closes a worker's announcements in batches that fit one packet each, across escrows and rent payers", async () => {
    const { w, client, judge, owner } = await job();
    const worker = await fundedSigner(w);
    const intents: Address[] = [];
    for (let i = 0; i <= RECLAIM_BATCH; i++) {
      const params = { kind: Kind.AttestedResult, amountIn: 1_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
      const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
      await client.announce({ worker, payer: await fundedSigner(w), intent: made.intent, sha256: WORK, url: workUrl() });
      await client.cancel(owner, { owner: owner.address, nonce: made.nonce });
      intents.push(made.intent);
    }
    const mine = await client.announcementsBy(worker.address);
    const widest = await Promise.all(
      mine.slice(0, RECLAIM_BATCH).map(({ address, intent, payer }) => buildCloseAnnouncement({ by: worker, announcement: address, intent, rentTo: payer })),
    );
    const size = await transactionBytes(client.transport, await budgeted(client.transport, 1n, widest, worker.address), worker.address);
    expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const reclaimed = await client.reclaim({ worker });
    expect(reclaimed.closed).toHaveLength(RECLAIM_BATCH + 1);
    expect(reclaimed.signatures).toHaveLength(2);
    expect(intents).toHaveLength(RECLAIM_BATCH + 1);
  });

  it("splits a release among co-authors that include the announcer, on each one's signature over the split", async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [worker, coauthor] = [await fundedSigner(w), await fundedSigner(w)];
    const delivered = await announced(client, worker, intent, WORK);
    const recipients = [
      { wallet: worker.address, weight: 7_000 },
      { wallet: coauthor.address, weight: 3_000 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const stranger: Address = (await fundedSigner(w)).address;
    await expect(client.splitBallot({ ...target, recipients: [{ wallet: stranger, weight: 10_000 }] })).rejects.toThrow(NotSettleable);
    const ballot = await client.splitBallot(target);
    expect(ballot).toMatchObject({ intent, attestor: judge.signer.address, worker: worker.address });
    expect([...ballot.cosigners].sort()).toEqual([worker.address, coauthor.address, judge.signer.address].sort());
    const signatures = await Promise.all([worker, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    const forged = [signatures[0] ?? { wallet: worker.address, signature: new Uint8Array(64) }, { wallet: coauthor.address, signature: new Uint8Array(64) }];
    await expect(client.settleSplit({ ...target, judge: judge.signer, signatures: forged })).rejects.toThrow(CosignRejected);
    await client.settleSplit({ ...target, judge: judge.signer, signatures, payer: owner });
    const { net } = splitFees(PAY, FEE_BPS, 0, 0);
    expect([await tokensOf(w, worker.address), await tokensOf(w, coauthor.address)]).toEqual(splitN(net, [7_000, 3_000]));
    const list = await client.announcements(intent);
    expect(list.announcements[0]?.splitHash).toEqual(ballot.splitHash);
  });
});
