import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, type TransactionSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  announcementCommitment,
  blobLayout,
  buildAnnounceDelivery,
  buildCreateProfile,
  buildOpenClaimsListed,
  buildSetAnnounceFee,
  delivery,
  Kind,
  NATIVE_MINT,
  newEncryptionKeyFile,
  readEncryptionKeyFile,
  sealDeliveryV4,
  signCommitteeVote,
} from "@intent-engine/core";
import { committeeKeys } from "../src/announce-keys.js";
import {
  AnnouncementsUnreadable,
  createClient,
  FirstOpeningRefused,
  NoMessageSigner,
  NotSettleable,
  PayToNotWallet,
  UrlTooLong,
} from "../src/index.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const WORK = sha("the pinned work");

const BULLETS = {
  announce:
    "`announce` records a worker's delivery on chain: an announcement account with a commitment that binds the work's sha256 to the worker's wallet and a salt, and the salt and url sealed to the judge's published encryption key, to the key derived from its wallet when it publishes none, or to each committee member's key.",
  sync: "`announce` syncs a committee's keys first when its snapshot does not match its members' published keys, and announcing the same work and url again returns the same announcement without sending.",
  secret:
    "The salt and the sealing keys come from the worker's own signature over the intent and the sha256, so only its key derives them. `announce` refuses a signer that cannot sign messages, such as a Ledger, with `NoMessageSigner`; such a worker passes `secret`, 32 bytes of its own that it keeps, or `saltSignature`, a signature made elsewhere, which must verify for the worker (`BadSaltSignature`).",
  url: "`announce` refuses a url longer than its transaction can carry with `UrlTooLong` before sending.",
  list: "`announcements` lists an escrow's announcements in seq order from accounts alone, never from transaction history, and says whether the list is `complete`: the escrow is open and every seq from 1 to one below its delivery book's `nextSeq` is present exactly once. Once the escrow is no longer open or its book is gone, the list says `closed` and is never complete.",
  first:
    "`firstOpening` returns the first announcement that opens to the checked sha256 with the keys it is given, and refuses with `FirstOpeningRefused` while the list is incomplete, an earlier announcement is sealed to a key it was not given, or another worker holds the claim.",
  skip: "An earlier announcement sealed to a key `firstOpening` was given that does not open with that key can never open for anyone, so `firstOpening` passes over it and lists it in `skipped`, for a judge and for each committee member alike.",
  transport: "A transport you pass to `createClient` needs `engineAccounts` to list announcements.",
};

const SENTENCES = {
  settle: "`settleProof` is the judge's call: it pays the worker that made the announcement it names, given its opening, the work's sha256 and the announcement's salt.",
  refuses:
    "Before sending, it refuses an expired escrow (`EscrowExpired`), a worker owned by a program (`PayToNotWallet`), a worker whose token account moved (`PayeeMoved`), an opening that does not open the announcement (`NotSettleable`) and an escrow another worker has claimed (`ClaimHeldBy`).",
  relay: "Here your wallet pays for the worker's announcement and for the release, so neither new key needs SOL.",
  signs: "`settleProof`, `settleCommittee` and `settleSplit` sign over the announcement and its opening and pay the announcing worker's token account; any wallet can send the signed release.",
  history: "`history` reads the paid work's sha256 and salt from the release itself.",
  cleanup:
    "`refute` lets an earlier worker record on chain that a later announcement of the same work was paid, `reclaim` closes every announcement of a worker that the program lets close now, rent back to whoever paid it, and `closeBook` closes an escrow's empty delivery book.",
};

async function escrowTo(attestor: Address, w?: World) {
  const chain = w ?? (await world());
  nativeMint(chain);
  const client = createClient({ url: LOCAL, transport: chain.chain.transport });
  const owner = await fundedSigner(chain);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the pinned spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: chain.outputMint });
  return { w: chain, client, owner, intent: made.intent, nonce: made.nonce };
}

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("the announcement sentences of the full client page", () => {
  it("states each announcement bullet these tests assert", () => {
    const section = PAGE.slice(PAGE.indexOf("## Find work and deliver it"), PAGE.indexOf("## Standing"));
    const bullets = [...section.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(bullets.slice(-Object.keys(BULLETS).length)).toEqual(Object.values(BULLETS));
    for (const sentence of Object.values(SENTENCES)) {
      expect(PAGE).toContain(sentence);
    }
  });

  it(BULLETS.announce, async () => {
    const w = await world();
    const judge = await keyed(w);
    const file = await newEncryptionKeyFile();
    const { client, intent } = await escrowTo(judge.signer.address, w);
    const worker = await fundedSigner(w);
    const made = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    const [listed] = (await client.announcements(intent)).announcements;
    expect(listed?.commitment).toEqual(await announcementCommitment(intent, worker.address, { delivered: bytes(WORK), salt: bytes(made.salt) }));
    expect(delivery.blobHead(listed?.blob ?? new Uint8Array()).mask).toBe(0);
    await w.chain.transport.send([await buildCreateProfile({ wallet: judge.signer, skills: ["judge"], endpoint: "https://" + "judge.example", encryptionKey: file.publicKey })], judge.signer);
    await client.announce({ worker, intent, sha256: WORK, url: workUrl("keyed") });
    expect(delivery.blobHead((await client.announcements(intent)).announcements[1]?.blob ?? new Uint8Array()).mask).toBe(1);
    expect(await client.firstOpening({ intent, sha256: WORK, keypair: [judge.keypair, await readEncryptionKeyFile(file.text)] })).toMatchObject({ url: workUrl() });
  });

  it(BULLETS.sync, async () => {
    const w = await world();
    const members = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const payer = await fundedSigner(w);
    const { committee } = await createClient({ url: LOCAL, transport: w.chain.transport }).createCommittee({ payer, members: members.map(({ address }) => address), threshold: 2, feeWallet: payer.address });
    const { client, intent } = await escrowTo(committee, w);
    const worker = await fundedSigner(w);
    const first = await client.announce({ worker, intent, sha256: WORK, url: workUrl() });
    expect(first.synced).toEqual(expect.any(String));
    expect((await committeeKeys(client.transport, committee))?.synced).toBe(true);
    const sent = w.chain.sent.length;
    expect(await client.announce({ worker, intent, sha256: WORK, url: workUrl() })).toEqual({ ...first, signature: null, synced: null });
    expect(w.chain.sent).toHaveLength(sent);
  });

  it(BULLETS.secret, async () => {
    const judge = await generateKeyPairSigner();
    const { w, client, intent } = await escrowTo(judge.address);
    const signer = await fundedSigner(w);
    const device: TransactionSigner = { address: signer.address, signTransactions: (txs) => signer.signTransactions(txs) };
    const unsigned = { worker: device, intent, sha256: WORK, url: workUrl() } as unknown as Parameters<typeof client.announce>[0];
    await expect(client.announce(unsigned)).rejects.toThrow(NoMessageSigner);
    const secret = new Uint8Array(32).fill(3);
    expect((await client.announce({ worker: device, intent, sha256: WORK, url: workUrl(), secret })).seq).toBe(1n);
    const signed = await client.announce({ worker: signer, intent, sha256: WORK, url: workUrl("signed") });
    expect(signed.salt).not.toBe((await client.announce({ worker: device, intent, sha256: WORK, url: workUrl("kept"), secret })).salt);
  });

  it(BULLETS.url, async () => {
    const w = await world();
    const members = await Promise.all(Array.from({ length: 8 }, () => generateKeyPairSigner()));
    const payer = await fundedSigner(w);
    const { committee } = await createClient({ url: LOCAL, transport: w.chain.transport }).createCommittee({ payer, members: members.map(({ address }) => address), threshold: 2, feeWallet: payer.address });
    const { client, owner, intent } = await escrowTo(committee, w);
    const worker = await fundedSigner(w);
    await client.send([await buildSetAnnounceFee({ admin: w.authority, fee: 1 })], w.authority);
    await client.send([await buildOpenClaimsListed({ owner, intent, maxSecs: 3_600, stake: 1_000_000n, size: 1, workers: [worker.address] })], owner);
    const head = workUrl("");
    const sent = w.chain.sent.length;
    await expect(client.announce({ worker, payer, intent, sha256: WORK, url: head + "a".repeat(115 - head.length) })).rejects.toThrow(UrlTooLong);
    expect(w.chain.sent).toHaveLength(sent);
    expect((await client.announce({ worker, payer, intent, sha256: WORK, url: head + "a".repeat(114 - head.length) })).seq).toBe(1n);
  });

  it(BULLETS.list, async () => {
    const judge = await generateKeyPairSigner();
    const { w, client, owner, intent, nonce } = await escrowTo(judge.address);
    const [a, b] = [await fundedSigner(w), await fundedSigner(w)];
    await announced(client, a, intent, WORK);
    await announced(client, b, intent, WORK);
    const refuse = async (): Promise<never> => {
      throw new Error("history is not read");
    };
    const { signaturesOf: _, transactionsOf: __, transactionOf: ___, ...accounts } = w.chain.transport;
    const blind = createClient({ url: LOCAL, transport: { ...accounts, engineTransactions: refuse } });
    const list = await blind.announcements(intent);
    expect(list).toMatchObject({ complete: true, closed: false, nextSeq: 3n, missing: [] });
    expect(list.announcements.map(({ seq, worker }) => [seq, worker])).toEqual([
      [1n, a.address],
      [2n, b.address],
    ]);
    const listAll = accounts.engineAccounts as NonNullable<typeof accounts.engineAccounts>;
    const hiding = createClient({ url: LOCAL, transport: { ...accounts, engineTransactions: refuse, engineAccounts: async (filter) => (await listAll(filter)).filter(({ address }) => address !== list.announcements[1]?.address) } });
    expect(await hiding.announcements(intent)).toMatchObject({ complete: false, closed: false, missing: [2n] });
    await client.cancel(owner, nonce);
    expect(await blind.announcements(intent)).toMatchObject({ complete: false, closed: true, missing: [] });
  });

  it(BULLETS.first, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, intent } = await escrowTo(judge.signer.address, w);
    const [other, honest] = [await fundedSigner(w), await fundedSigner(w)];
    await announced(client, other, intent, sha("other work"));
    const made = await announced(client, honest, intent, WORK);
    await expect(client.firstOpening({ intent, sha256: WORK })).rejects.toThrow(FirstOpeningRefused);
    expect(await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair })).toMatchObject({ announcement: made.announcement, worker: honest.address });
  });

  it(BULLETS.skip, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const [griefer, honest] = [await fundedSigner(w), await fundedSigner(w)];
    const blob = await sealDeliveryV4({ source: new Uint8Array(32).fill(5), url: workUrl("grief"), recipients: [judge.signer.address] }, intent, griefer.address);
    const wrapped = blobLayout(1, blob.length).wrapped;
    blob[wrapped] = (blob[wrapped] ?? 0) ^ 0xff;
    const { announcement, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor: judge.signer.address, commitment: new Uint8Array(32).fill(7), blob });
    await client.send([instruction], griefer);
    const made = await announced(client, honest, intent, WORK);
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: judge.keypair });
    expect(first).toMatchObject({ announcement: made.announcement, skipped: [{ announcement, seq: 1n, worker: griefer.address, reason: "does-not-open" }] });
    await client.settleProof({ judge: judge.signer, owner: owner.address, nonce, announcement: first.announcement, opening: first, result: 1n });
    expect(await tokensOf(w, honest.address)).toBeGreaterThan(0n);
  });

  it(BULLETS.transport, async () => {
    const judge = await generateKeyPairSigner();
    const { w, intent } = await escrowTo(judge.address);
    const { engineAccounts: _, ...listless } = w.chain.transport;
    await expect(createClient({ url: LOCAL, transport: listless }).announcements(intent)).rejects.toThrow(AnnouncementsUnreadable);
  });

  it(SENTENCES.settle, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const worker = await fundedSigner(w);
    const made = await announced(client, worker, intent, WORK);
    await client.settleProof({ judge: judge.signer, owner: owner.address, nonce, ...made, result: 1n });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
  });

  it(SENTENCES.refuses, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const worker = await fundedSigner(w);
    const made = await announced(client, worker, intent, WORK);
    const settle = (opening = made.opening) => client.settleProof({ judge: judge.signer, owner: owner.address, nonce, ...made, opening, result: 1n });
    await expect(settle({ sha256: sha("not it"), salt: made.opening.salt })).rejects.toThrow(NotSettleable);
    const wallet = w.chain.svm.getAccount(worker.address);
    if (!wallet.exists) {
      throw new Error("no wallet");
    }
    w.chain.svm.setAccount({ ...wallet, programAddress: NATIVE_MINT });
    await expect(settle()).rejects.toThrow(PayToNotWallet);
  });

  it(SENTENCES.relay, async () => {
    const w = await world();
    const judge = await keyed(w, 0n);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const worker: KeyPairSigner = await generateKeyPairSigner();
    const made = await client.announce({ worker, payer: owner, intent, sha256: WORK, url: workUrl() });
    await client.settleProof({ judge: judge.signer, payer: owner, owner: owner.address, nonce, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n });
    expect([w.chain.svm.getBalance(worker.address) ?? 0n, w.chain.svm.getBalance(judge.signer.address) ?? 0n]).toEqual([0n, 0n]);
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
  });

  it(SENTENCES.signs, async () => {
    const w = await world();
    const members = [await keyed(w), await keyed(w)];
    const payer = await fundedSigner(w);
    const { committee } = await createClient({ url: LOCAL, transport: w.chain.transport }).createCommittee({ payer, members: members.map(({ signer }) => signer.address), threshold: 2, feeWallet: payer.address });
    const { client, owner, intent, nonce } = await escrowTo(committee, w);
    const worker = await fundedSigner(w);
    const made = await announced(client, worker, intent, WORK);
    const target = { owner: owner.address, nonce, ...made, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all(members.map(({ signer }) => signCommitteeVote(signer, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: payer, votes });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
  });

  it(SENTENCES.history, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const made = await announced(client, await fundedSigner(w), intent, WORK);
    await client.settleProof({ judge: judge.signer, owner: owner.address, nonce, ...made, result: 1n });
    expect((await client.history(intent)).find(({ name }) => name === "IntentAttested")).toMatchObject({ deliveredSha256: WORK, deliveredSalt: made.opening.salt });
  });

  it(SENTENCES.cleanup, async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(judge.signer.address, w);
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, WORK);
    const paid = await announced(client, late, intent, WORK);
    await client.settleProof({ judge: judge.signer, owner: owner.address, nonce, ...paid, result: 1n });
    const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl() });
    expect(w.chain.svm.getAccount(refutation).exists).toBe(true);
    const second = await escrowTo(judge.signer.address, w);
    await announced(second.client, early, second.intent, WORK);
    await second.client.cancel(second.owner, second.nonce);
    expect((await client.reclaim({ worker: early })).closed).toHaveLength(2);
    await client.closeBook(second.intent, owner);
    expect((await client.announcements(second.intent)).announcements).toEqual([]);
  });
});
