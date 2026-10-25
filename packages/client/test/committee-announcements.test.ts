import type { KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  blobLayout,
  buildAnnounceDelivery,
  buildCreateProfile,
  buildOpenClaimsListed,
  buildSetAnnounceFee,
  buildUpdateProfile,
  delivery,
  keyFingerprintV4,
  maxSealedUrl,
  newEncryptionKeyFile,
  parseEncryptionKey,
  readEncryptionKeyFile,
  sealDeliveryV4,
  signCommitteeVote,
} from "@intent-engine/core/internal";
import { committeeKeys, recipientsFor } from "../src/announce-keys.js";
import { createClient, UrlTooLong } from "../src/index.js";
import { world, type World } from "./svm.js";
import { fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the committee's work");
const PAY = 1_000_000n;
const ENDPOINT = "https://" + "member.example";

async function publish(w: World, wallet: KeyPairSigner, encryptionKey: string, update = false): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: ENDPOINT, encryptionKey };
  await w.chain.transport.send([update ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)], wallet);
}

async function committeeJob(size: number) {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const members: Keyed[] = [];
  for (let i = 0; i < size; i++) {
    members.push(await keyed(w));
  }
  const payer = await fundedSigner(w);
  const { committee } = await client.createCommittee({ payer, members: members.map(({ signer }) => signer.address), threshold: 2, feeWallet: payer.address });
  const view = await client.committee(committee);
  const sorted = (view?.members ?? []).map((address) => members.find(({ signer }) => signer.address === address) as Keyed);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the committee spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, committee, members: sorted, owner, intent: made.intent, nonce: made.nonce };
}

describe("announcing to a committee", () => {
  it("syncs an unsynced committee's keys first, seals to each member's key, and settles on member votes", async () => {
    const { w, client, committee, members, owner, intent, nonce } = await committeeJob(3);
    const [first, second, third] = members as [Keyed, Keyed, Keyed];
    const file = await newEncryptionKeyFile();
    await publish(w, first.signer, file.publicKey);
    expect((await committeeKeys(client.transport, committee))?.synced).toBe(false);
    const worker = await fundedSigner(w);
    const made = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    expect(made.synced).toEqual(expect.any(String));
    expect(w.chain.sent.indexOf(made.synced ?? "")).toBe(w.chain.sent.indexOf(made.signature ?? "") - 1);
    const keys = await committeeKeys(client.transport, committee);
    expect(keys).toMatchObject({ synced: true, mask: 0b001 });
    expect(keys?.fingerprints[0]).toEqual(await keyFingerprintV4(parseEncryptionKey(file.publicKey)));
    const [listed] = (await client.announcements(intent)).announcements;
    expect(delivery.blobHead(listed?.blob ?? new Uint8Array())).toMatchObject({ count: 3, mask: 0b001 });
    expect((await client.announce({ worker, intent, sha256: WORK, url: workUrl("second.tar") })).synced).toBeNull();

    for (const opener of [await readEncryptionKeyFile(file.text), second.keypair, third.keypair]) {
      expect(await client.firstOpening({ intent, sha256: WORK, keypair: opener })).toMatchObject({ announcement: made.announcement, worker: worker.address, url: workUrl() });
    }
    await expect(client.firstOpening({ intent, sha256: WORK, keypair: first.keypair })).rejects.toMatchObject({
      reason: "key-not-given",
      sealedTo: [
        { wallet: first.signer.address, kind: "profile", published: true },
        { wallet: second.signer.address, kind: "wallet" },
        { wallet: third.signer.address, kind: "wallet" },
      ],
    });
    const found = await client.firstOpening({ intent, sha256: WORK, keypair: second.keypair });
    const target = { intent: { owner: owner.address, nonce }, announcement: found.announcement, opening: found, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all([third, second].map(({ signer }) => signCommitteeVote(signer, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: second.signer, votes });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
    expect((await client.history(intent)).events.find(({ name }) => name === "IntentAttested")).toMatchObject({ deliveredSha256: WORK, deliveredSalt: found.salt });
  });

  it("syncs again once a member's published key no longer matches the committee's snapshot", async () => {
    const { w, client, committee, members, intent } = await committeeJob(3);
    const [first] = members as [Keyed];
    const worker = await fundedSigner(w);
    expect((await client.announce({ worker, intent, sha256: WORK, url: workUrl() })).synced).toEqual(expect.any(String));
    expect((await committeeKeys(client.transport, committee))?.mask).toBe(0);
    await publish(w, first.signer, (await newEncryptionKeyFile()).publicKey);
    expect((await client.announce({ worker, intent, sha256: WORK, url: workUrl("later.tar") })).synced).toEqual(expect.any(String));
    expect((await committeeKeys(client.transport, committee))?.mask).toBe(1);
    await publish(w, first.signer, (await newEncryptionKeyFile()).publicKey, true);
    const rotated = await client.announce({ worker, intent, sha256: WORK, url: workUrl("rotated.tar") });
    expect(rotated).toMatchObject({ seq: 3n, synced: expect.any(String) });
  });

  it("refuses a url longer than a relayed committee announcement with claims and a fee may carry, and sends one at the limit", async () => {
    const { w, client, owner, intent } = await committeeJob(8);
    const worker = await fundedSigner(w);
    const payer = await fundedSigner(w);
    await client.send([await buildSetAnnounceFee({ admin: w.authority, fee: 5_000 })], w.authority);
    await client.send([await buildOpenClaimsListed({ owner, intent, maxSecs: 3_600, stake: 1_000_000n, size: 1, workers: [worker.address] })], owner);
    const max = maxSealedUrl({ recipients: 8, committee: true, relayer: true, board: true, claimList: true, feeTo: true, priorityFee: true, version: 0 });
    expect(max).toBe(114);
    const head = workUrl("");
    const url = (bytes: number) => head + "a".repeat(bytes - head.length);
    const sent = w.chain.sent.length;
    const refused = await client.announce({ worker, payer, intent, sha256: WORK, url: url(max + 1) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UrlTooLong);
    expect(refused).toMatchObject({ bytes: max + 1, max, recipients: 8 });
    expect(w.chain.sent).toHaveLength(sent);
    const before = w.chain.svm.getBalance(w.feeRecipient.address) ?? 0n;
    const landed = await client.announce({ worker, payer, intent, sha256: WORK, url: url(max) });
    expect(landed.seq).toBe(1n);
    expect((w.chain.svm.getBalance(w.feeRecipient.address) ?? 0n) - before).toBe(5_000n);
  });

  it("lets a member whose slot does not open skip that announcement, list it, and vote with another member to pay the honest worker", async () => {
    const { w, client, committee, members, owner, intent, nonce } = await committeeJob(3);
    const [first, second, third] = members as [Keyed, Keyed, Keyed];
    const { recipients, sync } = await recipientsFor(client.transport, committee, intent);
    if (sync !== null) {
      await client.send([sync], owner);
    }
    const griefer = await fundedSigner(w);
    const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: workUrl("grief"), recipients }, intent, griefer.address);
    const slot = blobLayout(3, blob.length).wrapped;
    blob[slot] = (blob[slot] ?? 0) ^ 1;
    const { announcement: grief, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: committee, committee: true, commitment: new Uint8Array(32).fill(7), blob });
    await client.send([instruction], griefer);
    const worker = await fundedSigner(w);
    const made = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    const blocked = await client.firstOpening({ intent, sha256: WORK, keypair: first.keypair });
    expect(blocked).toMatchObject({ announcement: made.announcement, worker: worker.address });
    expect(blocked.skipped).toEqual([{ announcement: grief, seq: 1n, worker: griefer.address, reason: "does-not-open" }]);
    const opened = await client.firstOpening({ intent, sha256: WORK, keypair: second.keypair });
    expect(opened).toMatchObject({ announcement: made.announcement, skipped: [] });
    const target = { intent: { owner: owner.address, nonce }, announcement: blocked.announcement, opening: blocked, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all([first, second].map(({ signer }) => signCommitteeVote(signer, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: third.signer, votes });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
    expect(await tokensOf(w, griefer.address)).toBeNull();
  });
});
