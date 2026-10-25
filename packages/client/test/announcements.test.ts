import { type Address, generateKeyPairSigner, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  announcementCommitment,
  blobLayout,
  buildAnnounceDelivery,
  delivery,
  keyFingerprintV4,
  saltMessage,
  sealDeliveryV4,
  signMessageBytes,
  x25519PublicOf,
} from "@intent-engine/core/internal";
import { BadSaltSignature, createClient, InvalidInput, NoMessageSigner, NotDeliverable } from "../src/index.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keypairSigner, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the delivered work");
const OTHER = sha("some other work");
const PAY = 1_000_000n;

async function job(judge: Address, attestor: Address = judge) {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, owner, intent: made.intent, nonce: made.nonce };
}

const hexBytes = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

describe("announcing a delivery", () => {
  it("announces sealed to the judge's wallet key, returns its seq, commitment and salt, and returns the same announcement again", async () => {
    const judge = await generateKeyPairSigner();
    const { w, client, intent } = await job(judge.address);
    const worker = await fundedSigner(w);
    const first = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    expect(first).toMatchObject({ seq: 1n, attestor: judge.address, synced: null, salt: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(w.chain.sent).toContain(first.signature);
    const commitment = await announcementCommitment(intent, worker.address, { delivered: hexBytes(WORK), salt: hexBytes(first.salt) });
    expect(first.commitment).toBe(Buffer.from(commitment).toString("hex"));
    const sent = w.chain.sent.length;
    expect(await client.announce({ worker, intent, sha256: WORK.toUpperCase(), url: workUrl() })).toEqual({ ...first, signature: null });
    expect(w.chain.sent).toHaveLength(sent);
    const second = await client.announce({ worker, intent, sha256: WORK, url: workUrl("again.tar") });
    expect(second.seq).toBe(2n);
    const list = await client.announcements(intent);
    expect(list).toMatchObject({ intent, nextSeq: 3n, complete: true, missing: [] });
    expect(list.announcements.map(({ address, seq, worker: by, state }) => [address, seq, by, state])).toEqual([
      [first.announcement, 1n, worker.address, "announced"],
      [second.announcement, 2n, worker.address, "announced"],
    ]);
    expect((await client.announcementsBy(worker.address)).announcements.map(({ address }) => address)).toEqual([first.announcement, second.announcement]);
    expect((await client.announcementsTo(judge.address)).announcements.map(({ address }) => address)).toEqual([first.announcement, second.announcement]);
    expect((await client.announcementsTo(worker.address)).announcements).toEqual([]);
  });

  it("pays the earliest announcement that opens to the work, from two workers, and any wallet sends the judge's release", async () => {
    const judge = await keypairSigner();
    const { w, client, owner, intent, nonce } = await job(judge.signer.address);
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const copied = await announced(client, early, intent, WORK);
    await announced(client, late, intent, WORK, workUrl("mine.tar"));
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ intent, announcement: copied.announcement, seq: 1n, worker: early.address, salt: copied.opening.salt, url: workUrl(), sha256: WORK });
    const signature = await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, announcement: first.announcement, opening: first, result: 1n, payer: owner });
    expect(w.chain.sent).toContain(signature);
    expect(await tokensOf(w, early.address)).toBeGreaterThan(0n);
    expect(await tokensOf(w, late.address)).toBeNull();
    expect(w.chain.svm.getBalance(judge.signer.address) ?? 0n).toBe(0n);
    const attested = (await client.history(intent)).events.find(({ name }) => name === "IntentAttested");
    expect(attested).toMatchObject({ signature, deliveredSha256: WORK, deliveredSalt: first.salt });
    const list = await client.announcements(intent);
    expect(list.announcements.map(({ state }) => state)).toEqual(["paid", "announced"]);
    expect(Buffer.from(list.announcements[0]?.delivered ?? []).toString("hex")).toBe(WORK);
    expect((await client.intent({ owner: owner.address, nonce }))?.intent.status).toBe(IntentStatus.Filled);
  });

  it("walks past an earlier announcement of other work and pays the first that opens to the checked work", async () => {
    const judge = await keypairSigner();
    const { w, client, owner, intent, nonce } = await job(judge.signer.address);
    const [other, honest] = [await fundedSigner(w), await fundedSigner(w)];
    await announced(client, other, intent, OTHER);
    const delivered = await announced(client, honest, intent, WORK);
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: delivered.announcement, seq: 2n, worker: honest.address, skipped: [] });
    await expect(client.firstOpening({ intent, sha256: sha("nobody did this"), keypair: judge.keypair })).rejects.toMatchObject({ reason: "nothing-opens" });
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, announcement: first.announcement, opening: first, result: 1n, payer: owner });
    expect(await tokensOf(w, honest.address)).toBeGreaterThan(0n);
    expect(await client.announcements(intent)).toMatchObject({ complete: false, closed: true, missing: [] });
    const closed = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair }).catch((error: unknown) => error);
    expect(closed).toMatchObject({ reason: "incomplete", closed: true });
    expect((closed as Error).message).toContain("is no longer open, so its announcements may have been closed");
  });

  it("skips an earlier announcement under the judge's real fingerprint that does not open, lists it, and pays the honest worker", async () => {
    const judge = await keypairSigner();
    const { w, client, owner, intent, nonce } = await job(judge.signer.address);
    const [griefer, honest] = [await fundedSigner(w), await fundedSigner(w)];
    const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: workUrl("grief"), recipients: [judge.signer.address] }, intent, griefer.address);
    const wrapped = blobLayout(1, blob.length).wrapped;
    blob[wrapped] = (blob[wrapped] ?? 0) ^ 1;
    const commitment = await announcementCommitment(intent, griefer.address, { delivered: hexBytes(WORK), salt: crypto.getRandomValues(new Uint8Array(16)) });
    const { announcement: grief, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: judge.signer.address, commitment, blob });
    await client.send([instruction], griefer);
    expect(delivery.blobHead(blob).fps[0]).toEqual(await keyFingerprintV4(x25519PublicOf(judge.signer.address)));
    const delivered = await announced(client, honest, intent, WORK);
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: delivered.announcement, seq: 2n, worker: honest.address });
    expect(first.skipped).toEqual([{ announcement: grief, seq: 1n, worker: griefer.address, reason: "does-not-open" }]);
    await expect(client.firstOpening({ intent, sha256: WORK })).rejects.toMatchObject({ reason: "key-not-given", announcement: grief });
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, announcement: first.announcement, opening: first, result: 1n, payer: owner });
    expect(await tokensOf(w, honest.address)).toBeGreaterThan(0n);
    expect(await tokensOf(w, griefer.address)).toBeNull();
  });

  it("derives the secrets from 32 bytes a worker that cannot sign messages keeps, or from a salt signature it made", async () => {
    const judge = await keypairSigner();
    const { w, client, intent } = await job(judge.signer.address);
    const signing = await fundedSigner(w);
    const device: TransactionSigner = { address: signing.address, signTransactions: (txs) => signing.signTransactions(txs) };
    const unsigned = { worker: device, intent, sha256: WORK, url: workUrl() } as unknown as Parameters<typeof client.announce>[0];
    await expect(client.announce(unsigned)).rejects.toThrow(NoMessageSigner);
    await expect(client.announce({ worker: device, intent, sha256: WORK, url: workUrl(), secret: new Uint8Array(31) })).rejects.toThrow(InvalidInput);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const kept = await client.announce({ worker: device, intent, sha256: WORK, url: workUrl(), secret });
    expect(await client.announce({ worker: device, intent, sha256: WORK, url: workUrl(), secret })).toMatchObject({ announcement: kept.announcement, signature: null });
    expect(await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair })).toMatchObject({ announcement: kept.announcement, salt: kept.salt });
    const other = await fundedSigner(w);
    await expect(client.announce({ worker: device, intent, sha256: OTHER, url: workUrl(), saltSignature: await signMessageBytes(other, saltMessage(intent, OTHER)) })).rejects.toThrow(BadSaltSignature);
    const signature = await signMessageBytes(signing, saltMessage(intent, OTHER));
    const signed = await client.announce({ worker: device, intent, sha256: OTHER, url: workUrl(), saltSignature: signature });
    expect(signed.salt).toBe((await client.announce({ worker: signing, intent, sha256: OTHER, url: workUrl() })).salt);
  });

  it("refuses an intent that is not an open proof escrow", async () => {
    const judge = await generateKeyPairSigner();
    const { w, client, owner, intent, nonce } = await job(judge.address);
    const worker: KeyPairSigner = await fundedSigner(w);
    const swap = await client.createIntent({ signer: owner, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n }, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    await expect(client.announce({ worker, intent: swap.intent, sha256: WORK, url: workUrl() })).rejects.toThrow(NotDeliverable);
    await client.cancel(owner, { owner: owner.address, nonce });
    await expect(client.announce({ worker, intent, sha256: WORK, url: workUrl() })).rejects.toThrow("is no longer open");
  });
});
