import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, KeyPairSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import {
  announcementCommitment,
  blobLayout,
  buildAnnounceDelivery,
  buildCloseAnnouncement,
  buildCreateProfile,
  buildRefuteRelease,
  buildUpdateProfile,
  decodeEvent,
  delivery,
  deliverySecrets,
  newEncryptionKeyFile,
  refutationAddress,
  sealDeliveryV4,
  signMessageBytes,
  splitN,
} from "@intent-engine/core/internal";
import { connect, createClient, type EngineTransaction, type Transport, trustOf } from "../src/index.js";
import { ACCOUNTS_UNREADABLE, reputationOf } from "../src/internal.js";
import { FEE_BPS, world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const WORK = sha("the standing work");
const PAY = 1_000_000n;

const BULLETS = {
  announced:
    "`reputation` finds a worker's announcements in the `DeliveryAnnounced` events of its own signed transactions and reads each release from the history of the announcement it paid, so a paid record stays after its announcement account closes.",
  coauthor:
    "A wallet counts as a co-author only when a split release names it as a payee; its record names the paid announcement and the role `co-author`, and announcing on the escrow alone credits nothing.",
  refutation:
    "A refutation counts against the paid worker only when the earlier announcement's stored blob opens under the revealed ephemeral key, at every slot, to the paid work (`substantiated`); `unsubstantiated` refutations and `unverifiable` ones, whose recipients' keys can no longer be known, are listed on the record and not counted.",
  complete: "`complete` is false, with a `reason`, whenever a page limit or an unreadable account cut the record short.",
  trust: "`trustOf` adds an edge from a payer to a worker only for a paid record whose release the reputation read verified, and never for a self-dealt one.",
};

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

async function job(w?: World) {
  const chain = w ?? (await world());
  nativeMint(chain);
  const client = createClient({ url: LOCAL, transport: chain.chain.transport });
  const judge = await keyed(chain);
  const owner = await fundedSigner(chain);
  const escrow = async (attestor: Address = judge.signer.address) => {
    const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the standing spec"), judgeFee: 0n } as const;
    return client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: chain.outputMint });
  };
  const made = await escrow();
  return { w: chain, client, judge, owner, escrow, intent: made.intent, nonce: made.nonce };
}

async function unopenable(client: ReturnType<typeof createClient>, worker: KeyPairSigner, judge: Keyed, intent: Address) {
  const source = crypto.getRandomValues(new Uint8Array(32));
  const recipients = [judge.signer.address];
  const { salt, esk } = await deliverySecrets(workUrl("unopenable"), recipients, source);
  const blob = await sealDeliveryV4({ source, url: workUrl("unopenable"), recipients }, intent, worker.address);
  const wrapped = blobLayout(1, blob.length).wrapped;
  blob[wrapped] = (blob[wrapped] ?? 0) ^ 1;
  const commitment = await announcementCommitment(intent, worker.address, { delivered: bytes(WORK), salt });
  const { announcement, instruction } = await buildAnnounceDelivery({ worker, intent, attestor: judge.signer.address, commitment, blob });
  await client.send([instruction], worker);
  return { announcement, salt, esk };
}

const withoutAuthority = (transport: Transport, names: readonly string[]): Transport => {
  const strip = (found: EngineTransaction[]) =>
    found.map((tx) =>
      tx.emittedAccounts === undefined
        ? tx
        : { ...tx, emittedAccounts: tx.emittedAccounts.map((accounts, i) => (names.includes(decodeEvent(tx.emitted[i] ?? new Uint8Array())?.name ?? "") ? [tx.feePayer as Address] : accounts)) },
    );
  const transactionsOf = transport.transactionsOf as NonNullable<Transport["transactionsOf"]>;
  return { ...transport, engineTransactions: async (limit, of, memo) => strip(await transport.engineTransactions(limit, of, memo)), transactionsOf: async (listed) => strip(await transactionsOf(listed)) };
};

describe("worker standing from announcements, releases and refutations", () => {
  it("states each standing bullet these tests assert", () => {
    const section = PAGE.slice(PAGE.indexOf("## Standing"), PAGE.indexOf("## Who can do what"));
    expect([...section.matchAll(/^- (.+)$/gm)].map((m) => m[1])).toEqual(Object.values(BULLETS));
  });

  it(BULLETS.announced, async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [worker, stranger] = [await fundedSigner(w), await fundedSigner(w)];
    const made = await announced(client, worker, intent, WORK);
    const release = await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...made, result: 1n });
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp += delivery.REFUTE_WINDOW_SECS + 1n;
    w.chain.svm.setClock(clock);
    await client.send([await buildCloseAnnouncement({ by: stranger, announcement: made.announcement, intent, rentTo: worker.address })], stranger);
    await client.close(stranger, { owner: owner.address, nonce });
    expect(w.chain.svm.getAccount(made.announcement).exists).toBe(false);
    expect(await client.intent({ owner: owner.address, nonce })).toBeNull();
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, announced: 1, paid: 1 });
    expect(rep.records).toMatchObject([{ intent, announcement: made.announcement, seq: 1n, role: "announcer", outcome: "paid", release, sha256: WORK, refutations: [] }]);
  });

  it(BULLETS.coauthor, async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [worker, coauthor, bystander] = [await fundedSigner(w), await fundedSigner(w), await fundedSigner(w)];
    const delivered = await announced(client, worker, intent, WORK);
    const own = await announced(client, coauthor, intent, WORK, workUrl("mine.tar"));
    const watched = await announced(client, bystander, intent, WORK, workUrl("watched.tar"));
    const recipients = [
      { wallet: worker.address, weight: 7_000 },
      { wallet: coauthor.address, weight: 3_000 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([worker, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    const release = await client.settleSplit({ ...target, judge: judge.signer, signatures, payer: owner });
    const shares = splitN(splitFees(PAY, FEE_BPS, 0, 0).net, [7_000, 3_000]);
    const credited = await client.reputation(coauthor.address);
    expect(credited).toMatchObject({ complete: true, announced: 1, paid: 1, earned: [{ mint: NATIVE_MINT, amount: shares[1] }] });
    expect(credited.records).toMatchObject([{ announcement: delivered.announcement, seq: 1n, role: "co-author", outcome: "paid", release, earned: shares[1] }]);
    expect(credited.records[0]?.announcement).not.toBe(own.announcement);
    expect((await client.reputation(worker.address)).records).toMatchObject([{ announcement: delivered.announcement, role: "announcer", outcome: "paid", earned: shares[0] }]);
    const bystanding = await client.reputation(bystander.address);
    expect(bystanding).toMatchObject({ complete: true, announced: 1, paid: 0, earned: [] });
    expect(bystanding.records).toMatchObject([{ announcement: watched.announcement, role: "announcer", outcome: "paid-other" }]);
    expect(bystanding.records[0]?.earned).toBeUndefined();
  });

  it(BULLETS.refutation, async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [griefer, early, late] = [await fundedSigner(w), await fundedSigner(w), await fundedSigner(w)];
    const grief = await unopenable(client, griefer, judge, intent);
    const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
    const paid = await announced(client, late, intent, WORK);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...paid, result: 1n });
    await client.send([await buildRefuteRelease({ earlierWorker: griefer, payer: griefer, paid: paid.announcement, earlier: grief.announcement, salt: grief.salt, esk: grief.esk })], griefer);
    const unsubstantiated = { refutation: await refutationAddress(grief.announcement), earlier: grief.announcement, earlierSeq: 1n, earlierWorker: griefer.address, standing: "unsubstantiated" };
    const alone = await client.reputation(late.address);
    expect(alone).toMatchObject({ complete: true, paid: 1, refuted: 0 });
    expect(alone.records).toMatchObject([{ announcement: paid.announcement, outcome: "paid", refutations: [unsubstantiated] }]);
    expect(alone.records[0]?.refutedBy).toBeUndefined();
    const buyer = await connect({ cluster: "devnet", signer: owner, transport: w.chain.transport });
    expect(await buyer.receipt({ escrow: intent })).toMatchObject({ payee: late.address, valid: true, refutedBy: null, complete: true });
    const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") });
    const both = await client.reputation(late.address);
    expect(both).toMatchObject({ complete: true, paid: 0, refuted: 1 });
    expect(both.records).toMatchObject([{ refutedBy: refutation, refutations: [unsubstantiated, { refutation, earlier: earlier.announcement, earlierSeq: 2n, earlierWorker: early.address, standing: "substantiated" }] }]);
    expect(await buyer.receipt({ escrow: intent })).toMatchObject({ refutedBy: refutation });
  });

  it("lists a refutation sealed to a profile key the judge has since replaced as unverifiable, and does not count it", async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const profile = async (update: boolean) => {
      const fields = { wallet: judge.signer, skills: ["judge"], endpoint: "https://" + "judge.example", encryptionKey: (await newEncryptionKeyFile()).publicKey };
      await client.send([update ? await buildUpdateProfile(fields) : await buildCreateProfile(fields)], judge.signer);
    };
    await profile(false);
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
    const paid = await announced(client, late, intent, WORK);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...paid, result: 1n });
    const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") });
    expect((await client.reputation(late.address)).records).toMatchObject([{ refutedBy: refutation, refutations: [{ refutation, standing: "substantiated" }] }]);
    await profile(true);
    const rotated = await client.reputation(late.address);
    expect(rotated).toMatchObject({ paid: 1, refuted: 0 });
    expect(rotated.records).toMatchObject([{ outcome: "paid", refutations: [{ refutation, standing: "unverifiable" }] }]);
    expect(rotated.records[0]?.refutedBy).toBeUndefined();
  });

  it(BULLETS.complete, async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const worker = await fundedSigner(w);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...(await announced(client, worker, intent, WORK)), result: 1n });
    expect(await client.reputation(worker.address)).toMatchObject({ complete: true, paid: 1 });
    expect((await client.reputation(worker.address)).reason).toBeUndefined();
    const { engineAccounts: _, ...blind } = w.chain.transport;
    expect(await reputationOf(blind, worker.address)).toMatchObject({ complete: false, paid: 1, reason: ACCOUNTS_UNREADABLE });
    for (let i = 0; i < 3; i++) {
      await w.chain.transport.send([getTransferSolInstruction({ source: worker, destination: worker.address, amount: BigInt(i) })], worker);
    }
    const listAll = w.chain.transport.signaturesOf as NonNullable<Transport["signaturesOf"]>;
    const paged: Transport = { ...w.chain.transport, signaturesOf: async (of, _limit, before) => listAll(of, 1, before) };
    expect(await reputationOf(paged, worker.address, { pages: 1 })).toMatchObject({ complete: false, reason: `the history of ${worker.address} was not read to its start` });
  });

  it(BULLETS.trust, async () => {
    const { w, client, judge, owner, escrow, intent, nonce } = await job();
    const worker = await fundedSigner(w);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...(await announced(client, worker, intent, WORK)), result: 1n });
    const transport = w.chain.transport;
    expect((await trustOf(transport, owner.address, worker.address)).score).toBeGreaterThan(0);
    const forged = withoutAuthority(transport, ["DeliveryReleased"]);
    expect(await reputationOf(forged, worker.address)).toMatchObject({ paid: 0 });
    expect((await trustOf(forged, owner.address, worker.address)).score).toBe(0);
    const unannounced = withoutAuthority(transport, ["DeliveryAnnounced"]);
    expect(await reputationOf(unannounced, worker.address)).toMatchObject({ announced: 0, paid: 0 });
    const self = await fundedSigner(w);
    const own = await escrow(self.address);
    const selfMade = await announced(client, self, own.intent, sha("self-judged work"));
    await client.settleProof({ judge: self, intent: { owner: owner.address, nonce: own.nonce }, ...selfMade, result: 1n });
    expect(await reputationOf(transport, self.address)).toMatchObject({ paid: 0, selfDealt: 1 });
    expect((await trustOf(transport, owner.address, self.address)).score).toBe(0);
  });
});
