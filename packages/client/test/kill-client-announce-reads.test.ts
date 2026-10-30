import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { Kind, NATIVE_MINT, NotAnEngineAccount } from "@intent-engine/core";
import {
  ANNOUNCEMENT_DISCRIMINATOR,
  deliveryBookAddress,
  getAnnouncementDecoder,
  getAnnouncementEncoder,
  getAnnouncementSize,
  getDeliveryBookDecoder,
  getDeliveryBookEncoder,
  getRefutationEncoder,
  REFUTATION_VERSION,
} from "@intent-engine/core/internal";
import { createClient, type EngineAccount, type Transport } from "../src/index.js";
import { announcementsBy, announcementsIn, announcementsOf, announcementsTo, loadAnnouncement, refutationsOf } from "../src/announcement-reads.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the listed work");

const addressAt = (i: number): Address => getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, at) => (at < 4 ? (i >> (8 * at)) & 0xff : 0x5a)));

async function setup() {
  const w = await world();
  nativeMint(w);
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const honest = await fundedSigner(w);
  const delivered = await announced(client, honest, made.intent, WORK);
  const real = w.chain.svm.getAccount(delivered.announcement);
  if (!real.exists) {
    throw new Error("no announcement");
  }
  const stored = getAnnouncementDecoder().decode(new Uint8Array(real.data));
  const account = (i: number, seq: bigint, over: Partial<typeof stored> = {}, lamports = BigInt(i)): EngineAccount => ({
    address: addressAt(i),
    data: new Uint8Array(getAnnouncementEncoder().encode({ ...stored, seq, ...over })),
    lamports,
  });
  const serving = (accounts: readonly EngineAccount[]): Transport => ({ ...w.chain.transport, engineAccounts: async () => [...accounts] });
  const book = async (intent: Address, over: { nextSeq?: bigint; live?: bigint }) => {
    const at = await deliveryBookAddress(intent);
    const held = w.chain.svm.getAccount(at);
    if (!held.exists) {
      throw new Error("no delivery book");
    }
    const data = new Uint8Array(getDeliveryBookEncoder().encode({ ...getDeliveryBookDecoder().decode(new Uint8Array(held.data)), ...over }));
    w.chain.svm.setAccount({ ...held, data });
  };
  return { w, client, judge, owner, params, made, honest, delivered, stored, account, serving, book };
}

const seqsOf = (list: { announcements: { seq: bigint }[] }) => list.announcements.map(({ seq }) => seq);

describe("reading one announcement", () => {
  it("refuses data whose tag is wrong or whose length is wrong, and reads the real one", async () => {
    const { w, delivered } = await setup();
    const real = await w.chain.transport.getAccount(delivered.announcement);
    if (real === null) {
      throw new Error("no announcement");
    }
    const via = (data: Uint8Array): Transport => ({ ...w.chain.transport, getAccount: async () => ({ ...real, data }) });
    const flipped = new Uint8Array(real.data);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const message = `${delivered.announcement} is not an engine announcement`;
    expect(real.data.length).toBe(getAnnouncementSize());
    expect((await loadAnnouncement(via(new Uint8Array(real.data)), delivered.announcement))?.address).toBe(delivered.announcement);
    await expect(loadAnnouncement(via(flipped), delivered.announcement)).rejects.toThrow(message);
    await expect(loadAnnouncement(via(real.data.slice(0, real.data.length - 1)), delivered.announcement)).rejects.toThrow(message);
    await expect(loadAnnouncement(via(new Uint8Array([...real.data, 0])), delivered.announcement)).rejects.toThrow(message);
    await expect(loadAnnouncement(via(new Uint8Array([...flipped, 0])), delivered.announcement)).rejects.toThrow(message);
    await expect(loadAnnouncement(via(flipped), delivered.announcement)).rejects.toBeInstanceOf(NotAnEngineAccount);
    expect(await loadAnnouncement({ ...w.chain.transport, getAccount: async () => null }, delivered.announcement)).toBeNull();
  });
});

describe("matching a listed account against the filter", () => {
  it("keeps an account that ends exactly where the filter field ends and drops one that is a byte short or holds other bytes", async () => {
    const { made, account, serving, stored } = await setup();
    const exact = new Uint8Array(40);
    exact.set(ANNOUNCEMENT_DISCRIMINATOR);
    exact.set(new Uint8Array(account(1, 1n).data).subarray(8, 40), 8);
    const short = exact.subarray(0, 39);
    const other = new Uint8Array(account(1, 1n, { intent: addressAt(77) }).data);
    const unrelated = new Uint8Array(getAnnouncementSize());
    const given = (data: Uint8Array): EngineAccount => ({ address: addressAt(5), data, lamports: 1n });
    const kept = await announcementsIn(serving([given(exact)]), made.intent);
    expect(kept.announcements).toEqual([]);
    expect(kept.unreadable).toHaveLength(1);
    expect((await announcementsIn(serving([given(short)]), made.intent)).unreadable).toEqual([]);
    expect(await announcementsIn(serving([given(other)]), made.intent)).toEqual({ announcements: [], unreadable: [] });
    expect(await announcementsIn(serving([given(unrelated)]), made.intent)).toEqual({ announcements: [], unreadable: [] });
    expect(stored.intent).toBe(made.intent);
  });
});

describe("ordering a listing", () => {
  it("orders by seq, and equal seqs by address, whatever order the node returns them in", async () => {
    const { made, account, serving } = await setup();
    const mixed = [account(3, 2n), account(2, 1n), account(1, 2n), account(4, 3n), account(5, 1n)];
    const expected = [...[2, 5].map(addressAt).sort(), ...[3, 1].map(addressAt).sort(), addressAt(4)];
    for (const given of [mixed, [...mixed].reverse()]) {
      const found = await announcementsIn(serving(given), made.intent);
      expect(found.announcements.map(({ address }) => address)).toEqual(expected);
    }
  });

  it("keeps the order of two entries with the same seq and the same address", async () => {
    const { made, account, serving } = await setup();
    const first = account(9, 4n, { slot: 1n });
    const second = account(9, 4n, { slot: 2n });
    expect((await announcementsIn(serving([first, second]), made.intent)).announcements.map(({ slot }) => slot)).toEqual([1n, 2n]);
    expect((await announcementsIn(serving([second, first]), made.intent)).announcements.map(({ slot }) => slot)).toEqual([2n, 1n]);
  });

  it("orders announcements to a judge and by a worker by escrow first and by seq within an escrow", async () => {
    const { judge, honest, account, serving } = await setup();
    const [low, middle, high] = [addressAt(0x101), addressAt(0x202), addressAt(0x303)].sort() as [Address, Address, Address];
    const given = [account(1, 2n, { intent: middle }), account(2, 1n, { intent: high }), account(3, 1n, { intent: low }), account(4, 1n, { intent: middle }), account(5, 2n, { intent: low })];
    const expected = [addressAt(3), addressAt(5), addressAt(4), addressAt(1), addressAt(2)];
    for (const order of [given, [...given].reverse()]) {
      const to = await announcementsTo(serving(order), judge.signer.address);
      const by = await announcementsBy(serving(order), honest.address);
      expect(to.announcements.map(({ address }) => address)).toEqual(expected);
      expect(by.announcements.map(({ address }) => address)).toEqual(expected);
      expect(to.announcements.map(({ intent, seq }) => [intent, seq])).toEqual([
        [low, 1n],
        [low, 2n],
        [middle, 1n],
        [middle, 2n],
        [high, 1n],
      ]);
    }
  });
});

describe("whether a listing is complete", () => {
  it("is complete when every seq below the book's next seq is listed once", async () => {
    const { made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 3n });
    const list = await announcementsOf(serving([account(2, 2n), account(1, 1n)]), made.intent);
    expect(list).toMatchObject({ complete: true, closed: false, nextSeq: 3n, missing: [] });
    expect(seqsOf(list)).toEqual([1n, 2n]);
  });

  it("is incomplete when a seq is listed twice even though the count matches the book", async () => {
    const { made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 3n });
    const list = await announcementsOf(serving([account(1, 1n), account(2, 1n)]), made.intent);
    expect(list).toMatchObject({ complete: false, missing: [2n] });
  });

  it("is incomplete when the book is ahead of the listing", async () => {
    const { made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 3n });
    const list = await announcementsOf(serving([account(1, 1n)]), made.intent);
    expect(list).toMatchObject({ complete: false, missing: [2n], nextSeq: 3n });
  });

  it("is incomplete when the one listed seq lies at or past the next seq, or below one", async () => {
    const { made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 2n });
    expect(await announcementsOf(serving([account(1, 1n)]), made.intent)).toMatchObject({ complete: true, missing: [] });
    expect(await announcementsOf(serving([account(1, 5n)]), made.intent)).toMatchObject({ complete: false });
    expect(await announcementsOf(serving([account(1, 2n)]), made.intent)).toMatchObject({ complete: false });
    expect(await announcementsOf(serving([account(1, 0n)]), made.intent)).toMatchObject({ complete: false });
  });

  it("is incomplete when a listed account cannot be read", async () => {
    const { made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 2n });
    const broken = { ...account(2, 1n), data: new Uint8Array(account(2, 1n).data).fill(0, 0, 8) };
    const list = await announcementsOf(serving([account(1, 1n), broken]), made.intent);
    expect(list.complete).toBe(false);
  });

  it("names the missing seqs from the highest listed seq when the escrow has no book", async () => {
    const { w, client, owner, params, account, serving } = await setup();
    const other = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const list = await announcementsOf(serving([account(1, 5n, { intent: other.intent }), account(2, 3n, { intent: other.intent })]), other.intent);
    expect(list).toMatchObject({ nextSeq: 1n, complete: false, missing: [1n, 2n, 4n] });
    expect(seqsOf(list)).toEqual([3n, 5n]);
  });

  it("is closed, and so incomplete, at the very second the escrow expires", async () => {
    const { w, client, owner, made, account, serving, book } = await setup();
    await book(made.intent, { nextSeq: 2n });
    const open = await announcementsOf(serving([account(1, 1n)]), made.intent);
    expect(open).toMatchObject({ complete: true, closed: false });
    const held = await client.intent({ owner: owner.address, nonce: made.nonce });
    if (held === null) {
      throw new Error("no escrow");
    }
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp = held.intent.expiresAt - 1n;
    w.chain.svm.setClock(clock);
    expect(await announcementsOf(serving([account(1, 1n)]), made.intent)).toMatchObject({ complete: true, closed: false });
    clock.unixTimestamp = held.intent.expiresAt;
    w.chain.svm.setClock(clock);
    expect(await announcementsOf(serving([account(1, 1n)]), made.intent)).toMatchObject({ complete: false, closed: true });
  });
});

describe("listing refutations", () => {
  it("orders the refutations of a paid announcement by the seq of the earlier announcement", async () => {
    const { made, serving } = await setup();
    const paid = addressAt(0x500);
    const refutation = (i: number, earlierSeq: bigint, marker: bigint): EngineAccount => ({
      address: addressAt(i),
      data: new Uint8Array(
        getRefutationEncoder().encode({
          intent: made.intent,
          attestor: addressAt(0x501),
          paidAnnouncement: paid,
          earlierAnnouncement: addressAt(0x502),
          paidWorker: addressAt(0x503),
          earlierWorker: addressAt(0x504),
          refuter: addressAt(0x505),
          delivered: new Uint8Array(32),
          splitHash: new Uint8Array(32),
          earlierCommitment: new Uint8Array(32),
          esk: new Uint8Array(32),
          paidSeq: 9n,
          earlierSeq,
          refutedAt: marker,
          slot: 0n,
          salt: new Uint8Array(16),
          blobLen: 0,
          version: REFUTATION_VERSION,
          bump: 0,
          recipients: 0,
          padding: new Uint8Array(3),
          blob: new Uint8Array(1_000),
        }),
      ),
      lamports: 1n,
    });
    const seqs = async (given: readonly EngineAccount[]) => (await refutationsOf(serving(given), paid)).refutations.map(({ earlierSeq }) => earlierSeq);
    const unsorted = [refutation(1, 3n, 0n), refutation(2, 1n, 0n), refutation(3, 2n, 0n)];
    expect(await seqs(unsorted)).toEqual([1n, 2n, 3n]);
    expect(await seqs([...unsorted].reverse())).toEqual([1n, 2n, 3n]);
    const ties = (await refutationsOf(serving([refutation(4, 2n, 0n), refutation(5, 2n, 0n), refutation(6, 1n, 0n)]), paid)).refutations.map(({ address }) => address);
    expect(ties).toEqual([addressAt(6), addressAt(4), addressAt(5)]);
    const swapped = (await refutationsOf(serving([refutation(5, 2n, 0n), refutation(4, 2n, 0n)]), paid)).refutations.map(({ address }) => address);
    expect(swapped).toEqual([addressAt(5), addressAt(4)]);
  });

  it("compares two refutations by earlier seq with a negative, zero or positive number", async () => {
    const { made, serving } = await setup();
    const original = Array.prototype.sort;
    const comparators: ((a: unknown, b: unknown) => number)[] = [];
    const spy = vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare?: (a: never, b: never) => number) {
      if (compare !== undefined) {
        comparators.push(compare as (a: unknown, b: unknown) => number);
      }
      return original.call(this, compare as never);
    });
    try {
      await refutationsOf(serving([]), made.intent);
    } finally {
      spy.mockRestore();
    }
    const compare = comparators.at(-1);
    const seq = (earlierSeq: bigint) => ({ earlierSeq });
    expect(compare?.(seq(1n), seq(2n))).toBe(-1);
    expect(compare?.(seq(2n), seq(1n))).toBe(1);
    expect(compare?.(seq(2n), seq(2n))).toBe(0);
  });
});
