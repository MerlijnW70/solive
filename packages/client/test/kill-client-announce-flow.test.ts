import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  buildCreateProfile,
  buildSetAnnounceFee,
  deliveryBookAddress,
  getDeliveryBookDecoder,
  getDeliveryBookEncoder,
  maxSealedUrl,
  newEncryptionKeyFile,
  refutationAddress,
  signCommitteeVote,
} from "@intent-engine/core/internal";
import { BookNotClosable, createClient, NotDeliverable, NotRefutable } from "../src/index.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, type Keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the flowing work");
const BASE = { recipients: 1, committee: false, relayer: false, board: false, claimList: false, feeTo: false, priorityFee: true, version: 0 } as const;

async function job() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const held = await client.intent({ owner: owner.address, nonce: made.nonce });
  if (held === null) {
    throw new Error("no escrow");
  }
  const at = (seconds: bigint): void => {
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp = seconds;
    w.chain.svm.setClock(clock);
  };
  return { w, client, judge, owner, intent: made.intent, nonce: made.nonce, expires: held.intent.expiresAt, at };
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
  const sorted = (view?.members ?? []).map((address: Address) => members.find(({ signer }) => signer.address === address) as Keyed);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the committee spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, committee, members: sorted, owner, intent: made.intent, nonce: made.nonce };
}

describe("planning an announcement", () => {
  it("sizes the url limit to the accounts the transaction carries, with no claim board and no fee by default", async () => {
    const { w, client, intent } = await committeeJob(8);
    const worker = await fundedSigner(w);
    const relayer = await fundedSigner(w);
    const base = { ...BASE, recipients: 8, committee: true, relayer: true };
    const input = { worker, payer: relayer, intent, sha256: WORK, url: workUrl() };
    const plain = await client.plan.announce(input);
    expect(plain.maxUrl).toBe(maxSealedUrl(base));
    expect(maxSealedUrl({ ...base, board: true })).toBeLessThan(plain.maxUrl);
    expect(maxSealedUrl({ ...base, claimList: true })).toBeLessThan(plain.maxUrl);
    expect(maxSealedUrl({ ...base, feeTo: true })).toBeLessThan(plain.maxUrl);
    await client.send([await buildSetAnnounceFee({ admin: w.authority, fee: 5_000 })], w.authority);
    expect((await client.plan.announce(input)).maxUrl).toBe(maxSealedUrl({ ...base, feeTo: true }));
  });

  it("refuses to announce to an escrow at the very second it expires and plans one a second earlier", async () => {
    const { w, client, intent, expires, at } = await job();
    const worker = await fundedSigner(w);
    const input = { worker, intent, sha256: WORK, url: workUrl() };
    at(expires - 1n);
    expect((await client.plan.announce(input)).intent).toBe(intent);
    at(expires);
    const refused = await client.plan.announce(input).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotDeliverable);
    expect(refused).toMatchObject({ reason: "not-open" });
    at(expires + 1n);
    await expect(client.plan.announce(input)).rejects.toMatchObject({ reason: "not-open" });
  });
});

describe("reclaiming and closing", () => {
  it("counts an escrow as open until the second it expires", async () => {
    const { w, client, intent, expires, at } = await job();
    const worker = await fundedSigner(w);
    const own = await announced(client, worker, intent, WORK);
    at(expires - 1n);
    const before = await client.plan.reclaim({ worker });
    expect(before.closed).toEqual([]);
    expect(before.reasons).toEqual([{ announcement: own.announcement, reason: `its escrow ${intent} is still open` }]);
    at(expires);
    const during = await client.plan.reclaim({ worker });
    expect(during.closed).toEqual([own.announcement]);
    expect(during.kept).toEqual([]);
  });

  it("closes a delivery book without announcements only once its escrow has expired", async () => {
    const { w, client, owner, intent, expires, at } = await job();
    const worker = await fundedSigner(w);
    await announced(client, worker, intent, WORK);
    const address = await deliveryBookAddress(intent);
    const book = w.chain.svm.getAccount(address);
    if (!book.exists) {
      throw new Error("no delivery book");
    }
    const emptied = new Uint8Array(getDeliveryBookEncoder().encode({ ...getDeliveryBookDecoder().decode(new Uint8Array(book.data)), live: 0n }));
    w.chain.svm.setAccount({ ...book, data: emptied });
    await expect(client.plan.closeBook(intent, owner)).rejects.toThrow(BookNotClosable);
    await expect(client.plan.closeBook(intent, owner)).rejects.toThrow("belongs to an escrow that is still open");
    at(expires - 1n);
    await expect(client.plan.closeBook(intent, owner)).rejects.toThrow("belongs to an escrow that is still open");
    at(expires);
    const plan = await client.plan.closeBook(intent, owner);
    expect(plan.instructions).toHaveLength(1);
    expect(plan.payer).toBe(owner.address);
    at(expires + 1n);
    expect((await client.plan.closeBook(intent, owner)).instructions).toHaveLength(1);
  });
});

async function publish(w: World, wallet: KeyPairSigner): Promise<void> {
  const fields = { wallet, skills: ["judge"], endpoint: "https://" + "member.example", encryptionKey: (await newEncryptionKeyFile()).publicKey };
  await w.chain.transport.send([await buildCreateProfile(fields)], wallet);
}

describe("refuting a committee's payment", () => {
  it("derives the secrets again for a member past the first whose published key sealed the announcement", async () => {
    const { w, client, members, owner, intent, nonce } = await committeeJob(3);
    const [, second, third] = members as [Keyed, Keyed, Keyed];
    await publish(w, second.signer);
    const [early, late] = [await fundedSigner(w), await fundedSigner(w)];
    const earlier = await client.announce({ worker: early, intent, sha256: WORK, url: workUrl("first.tar") });
    const paid = await client.announce({ worker: late, intent, sha256: WORK, url: workUrl("second.tar") });
    const target = { intent: { owner: owner.address, nonce }, announcement: paid.announcement, opening: { sha256: WORK, salt: paid.salt }, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all([third, second].map(({ signer }) => signCommitteeVote(signer, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: second.signer, votes });
    const refute = { worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar") };
    const sent = w.chain.sent.length;
    await expect(client.refute({ ...refute, url: workUrl("other.tar") })).rejects.toThrow(NotRefutable);
    expect(w.chain.sent).toHaveLength(sent);
    const refuted = await client.refute(refute);
    expect(refuted.refutation).toBe(await refutationAddress(earlier.announcement));
    expect(w.chain.sent).toContain(refuted.signature);
  });
});
