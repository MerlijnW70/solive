import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS, deliveryBookAddress, getDeliveryBookDecoder, getDeliveryBookEncoder } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { BOOK_BATCH, budgeted, PACKET_DATA_SIZE, RECLAIM_BATCH, transactionBytes } from "../src/internal.js";
import { world } from "./svm.js";
import { fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";
import { cancelAfterNotice } from "./notice.js";

const WORK = sha("the work whose book closes");

const BOOK_VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find(({ name }) => name === "delivery book")?.versionAt ?? 0);

const JOBS = BOOK_BATCH + 1;

async function jobs(count: number) {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const worker = await fundedSigner(w);
  const made: { intent: Address; announcement: Address; book: Address; payer: Address }[] = [];
  for (let i = 0; i < count; i++) {
    const params = { kind: Kind.AttestedResult, amountIn: 1_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
    const escrow = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const payer = await fundedSigner(w);
    const announced = await client.announce({ worker, payer, intent: escrow.intent, sha256: WORK, url: workUrl() });
    await cancelAfterNotice(client, w.chain.svm, owner, { owner: owner.address, nonce: escrow.nonce });
    made.push({ intent: escrow.intent, announcement: announced.announcement, book: await deliveryBookAddress(escrow.intent), payer: payer.address });
  }
  return { w, client, worker, made };
}

describe("a reclaim that closes the last announcements of escrows", () => {
  it("plans each book its closes leave empty, after them, with its rent going to the wallet that paid it", async () => {
    const { w, client, worker, made } = await jobs(JOBS);
    const plan = await client.plan.reclaim({ worker });
    const byBook = new Map(plan.books.map((one) => [one.book, one]));
    expect(byBook.size).toBe(JOBS);
    for (const { intent, announcement, book, payer } of made) {
      expect(byBook.get(book)).toMatchObject({ intent, rentTo: payer, rent: w.chain.svm.getBalance(book), after: [announcement] });
    }
    expect(plan.bookBatches.map((batch) => batch.length)).toEqual([BOOK_BATCH, 1]);
    expect(plan.bookBatches.flat()).toEqual(plan.books.map(({ instruction }) => instruction));
    const widest = plan.bookBatches[0] ?? [];
    expect(await transactionBytes(client.transport, await budgeted(client.transport, 1n, widest, worker.address), worker.address)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const balance = (address: Address): bigint => w.chain.svm.getBalance(address) ?? 0n;
    const before = made.map(({ payer, announcement, book }) => ({ payer: balance(payer), rent: balance(announcement) + balance(book) }));
    const done = await client.reclaim({ worker });
    expect(done.closed).toHaveLength(JOBS);
    expect([...done.books].sort()).toEqual(made.map(({ book }) => book).sort());
    expect(done.unclosed).toEqual([]);
    expect(done.signatures).toHaveLength(Math.ceil(JOBS / RECLAIM_BATCH) + Math.ceil(JOBS / BOOK_BATCH));
    made.forEach(({ book, payer }, i) => {
      expect(w.chain.svm.getAccount(book).exists).toBe(false);
      expect(balance(payer) - (before[i]?.payer ?? 0n)).toBe(before[i]?.rent);
    });
  });

  it("lists a book the program refuses to close, and every announcement and the other books, also those batched with it, still close", async () => {
    const { w, worker, made } = await jobs(JOBS);
    const plan = await createClient({ url: LOCAL, transport: w.chain.transport }).plan.reclaim({ worker });
    const last = plan.books[0]?.book as Address;
    let sends = 0;
    const announcing = Math.ceil(JOBS / RECLAIM_BATCH);
    const refusing = createClient({
      url: LOCAL,
      transport: {
        ...w.chain.transport,
        send: async (instructions, payer) => {
          sends += 1;
          if (sends === announcing + 1) {
            const view = w.chain.svm.getAccount(last);
            if (view.exists) {
              const data = Uint8Array.from(view.data);
              data[BOOK_VERSION_AT] = (data[BOOK_VERSION_AT] ?? 0) + 1;
              w.chain.svm.setAccount({ ...view, data });
            }
          }
          return w.chain.transport.send(instructions, payer);
        },
      },
    });
    const done = await refusing.reclaim({ worker });
    expect(done.closed).toHaveLength(JOBS);
    expect(done.unclosed).toEqual([last]);
    expect(done.books).toHaveLength(JOBS - 1);
    expect(done.books).not.toContain(last);
    expect(made.every(({ announcement }) => !w.chain.svm.getAccount(announcement).exists)).toBe(true);
    expect(made.filter(({ book }) => w.chain.svm.getAccount(book).exists).map(({ book }) => book)).toEqual([last]);
  });
  it("plans no book whose escrow is still open, even one with no live announcement", async () => {
    const w = await world();
    nativeMint(w);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const judge = await keyed(w);
    const owner = await fundedSigner(w);
    const worker = await fundedSigner(w);
    const params = { kind: Kind.AttestedResult, amountIn: 1_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
    const escrow = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const announced = await client.announce({ worker, intent: escrow.intent, sha256: WORK, url: workUrl() });
    const book = await deliveryBookAddress(escrow.intent);
    const view = w.chain.svm.getAccount(book);
    if (!view.exists) {
      throw new Error("no book");
    }
    w.chain.svm.setAccount({ ...view, data: Uint8Array.from(getDeliveryBookEncoder().encode({ ...getDeliveryBookDecoder().decode(view.data), live: 0n })) });
    const plan = await client.plan.reclaim({ worker });
    expect(plan.kept).toEqual([announced.announcement]);
    expect(plan.books).toEqual([]);
  });
});
