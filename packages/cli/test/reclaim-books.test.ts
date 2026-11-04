import { createHash } from "node:crypto";
import { type Address, createNoopSigner, type KeyPairSigner, lamports } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { decodeDeliveryBookAccount, deliveryBookAddress, getIntentDiscriminatorBytes, getIntentSize } from "@intent-engine/core/internal";
import { BOOK_BATCH, RECLAIM_BATCH } from "@intent-engine/client/internal";
import { createClient } from "@intent-engine/client/node";
import { BOOKS_UNCLOSED, reclaimBooksLine } from "../src/announce-commands.js";
import { BOOKS_REFUSED, booksLine, RECLAIM_MORE } from "../src/agent/wallet/refute.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, transport, world } from "./harness.js";
import { device, deviceKey, found, transactionThen } from "./ledger-device.js";
import { plantBook } from "./local-worker-kit.js";
import { approved } from "./approved.js";
import { cancelled, escrowTo, lamportsOf, ok, outdated, outdatedAfter, served, useWallet } from "./bound-books-kit.js";

const WORK = createHash("sha256").update("the reclaimed work\n").digest("hex");
const WORK_URL = "https://" + "work.example.org/" + "r".repeat(32);
const SIGNATURE_FEE = 5_000n;
const LEDGER_PATH = "usb://ledger?key=4";
const LEDGER_LEVELS = [44, 501, 4];

type Delivered = { announcement: Address; book: Address; bookRent: bigint; announcementRent: bigint };

const unreadable = (intent: Address): void => {
  const data = new Uint8Array(getIntentSize());
  data.set(getIntentDiscriminatorBytes());
  h.svm.setAccount({ address: intent, data, executable: false, lamports: lamports(10_000_000n), programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, space: BigInt(data.length) });
};

const bookOf = (book: Address) => {
  const view = h.svm.getAccount(book);
  return view.exists ? decodeDeliveryBookAccount(view.data) : null;
};

describe("a reclaim that closes the last announcement of an escrow", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let worker: KeyPairSigner;
  let intent: Address;

  beforeEach(async () => {
    w = await world();
    worker = await funded();
    intent = await escrowTo(w.owner, (await funded()).address, w.inputMint, w.outputMint);
  });

  async function deliveredBy(client: Client): Promise<Delivered> {
    const done = await ok(client, "wallet_deliver", await approved(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL }));
    const announcement = done["announcement"] as Address;
    const book = await deliveryBookAddress(intent);
    expect(bookOf(book)).toMatchObject({ payer: worker.address, live: 1n });
    await cancelled(w.owner);
    return { announcement, book, bookRent: lamportsOf(book), announcementRent: lamportsOf(announcement) };
  }

  async function deliveredByCli(): Promise<Delivered> {
    const sent = await cli(["deliver", "--url", "devnet", "--keypair", "worker.json", "--intent", intent, "--sha256", WORK, "--work-url", WORK_URL, "--yes"], { "worker.json": worker });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    const announcement = sent.json()["announcement"] as Address;
    const book = await deliveryBookAddress(intent);
    expect(bookOf(book)).toMatchObject({ payer: worker.address, live: 1n });
    await cancelled(w.owner);
    return { announcement, book, bookRent: lamportsOf(book), announcementRent: lamportsOf(announcement) };
  }

  it("closes the book in the same MCP call and returns its rent to the wallet that paid it", async () => {
    useWallet(worker);
    const client = await served();
    const job = await deliveredBy(client);
    const shown = await ok(client, "wallet_reclaim");
    expect(shown).toMatchObject({ closing: [job.announcement], books: [job.book], sent: false });
    expect(shown["summary"]).toContain(booksLine(1, job.bookRent));
    expect(bookOf(job.book)).toMatchObject({ live: 1n });
    const before = lamportsOf(worker.address);
    const done = await ok(client, "wallet_reclaim", { send: true });
    expect(done).toMatchObject({ closing: [job.announcement], books: [job.book], sent: true, next: "closed" });
    expect(done).not.toHaveProperty("unclosed");
    expect([h.svm.getAccount(job.announcement).exists, h.svm.getAccount(job.book).exists]).toEqual([false, false]);
    expect(lamportsOf(worker.address) - before).toBe(job.announcementRent + job.bookRent - 2n * SIGNATURE_FEE);
  }, 60_000);

  it("lists a book the program refuses to close, while the announcement still closes, over MCP", async () => {
    useWallet(worker);
    const job = await deliveredBy(await served());
    outdatedAfter(job.announcement, job.book);
    const client = await served();
    const done = await ok(client, "wallet_reclaim", { send: true });
    expect(done).toMatchObject({ closing: [job.announcement], books: [], unclosed: [job.book], sent: true, next: BOOKS_REFUSED });
    expect(h.svm.getAccount(job.announcement).exists).toBe(false);
    expect(h.svm.getAccount(job.book).exists).toBe(true);
  }, 60_000);

  it("closes the book in the same CLI reclaim and returns its rent to the wallet that paid it", async () => {
    const job = await deliveredByCli();
    const preview = await cli(["reclaim", "--url", "devnet", "--keypair", "worker.json"], { "worker.json": worker });
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    const shown = preview.json();
    expect(shown).toMatchObject({ closed: [job.announcement], books: [job.book], transactions: 2, sent: false });
    expect(shown["summary"]).toContain(reclaimBooksLine([{ book: job.book, rent: job.bookRent, rentTo: worker.address }], 1));
    expect(h.svm.getAccount(job.book).exists).toBe(true);
    const before = lamportsOf(worker.address);
    const sent = await cli(["reclaim", "--url", "devnet", "--keypair", "worker.json", "--yes"], { "worker.json": worker });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ closed: [job.announcement], books: [job.book], sent: true });
    expect(sent.json()).not.toHaveProperty("unclosed");
    expect([h.svm.getAccount(job.announcement).exists, h.svm.getAccount(job.book).exists]).toEqual([false, false]);
    expect(lamportsOf(worker.address) - before).toBe(job.announcementRent + job.bookRent - 2n * SIGNATURE_FEE);
  }, 60_000);

  it("lists a book the program refuses to close, while the announcement still closes, in the CLI", async () => {
    const job = await deliveredByCli();
    outdatedAfter(job.announcement, job.book);
    const sent = await cli(["reclaim", "--url", "devnet", "--keypair", "worker.json", "--yes"], { "worker.json": worker });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ closed: [job.announcement], books: [], unclosed: [job.book], sent: true, next: BOOKS_UNCLOSED });
    expect(h.svm.getAccount(job.announcement).exists).toBe(false);
    expect(h.svm.getAccount(job.book).exists).toBe(true);
  }, 60_000);

  it("closes a book this wallet paid for that an earlier reclaim left empty", async () => {
    useWallet(worker);
    const client = await served();
    const job = await deliveredBy(client);
    outdatedAfter(job.announcement, job.book);
    expect(await ok(await served(), "wallet_reclaim", { send: true })).toMatchObject({ unclosed: [job.book] });
    h.through = null;
    outdated(job.book, -1);
    expect(bookOf(job.book)).toMatchObject({ payer: worker.address, live: 0n });
    const again = await served();
    const shown = await ok(again, "wallet_reclaim");
    expect(shown).toMatchObject({ closing: [], books: [job.book], summary: [booksLine(1, job.bookRent)], sent: false });
    const before = lamportsOf(worker.address);
    expect(await ok(again, "wallet_reclaim", { send: true })).toMatchObject({ books: [job.book], sent: true });
    expect(h.svm.getAccount(job.book).exists).toBe(false);
    expect(lamportsOf(worker.address) - before).toBe(job.bookRent - SIGNATURE_FEE);
  }, 60_000);
  it("closes the book only in the MCP call that closes its last announcement, when there are more than one batch of them", async () => {
    useWallet(worker);
    const client = await served();
    const made: Address[] = [];
    for (let i = 0; i <= RECLAIM_BATCH; i++) {
      const done = await ok(client, "wallet_deliver", await approved(client, "wallet_deliver", { intent, sha256: (0xa0 + i).toString(16).repeat(32), url: WORK_URL }));
      made.push(done["announcement"] as Address);
    }
    await cancelled(w.owner);
    const book = await deliveryBookAddress(intent);
    const first = await ok(client, "wallet_reclaim", { send: true });
    expect(first).toMatchObject({ books: [], sent: true, next: RECLAIM_MORE });
    expect(first).not.toHaveProperty("unclosed");
    expect(first["closing"]).toHaveLength(RECLAIM_BATCH);
    expect(bookOf(book)).toMatchObject({ live: 1n });
    const last = made.filter((announcement) => !(first["closing"] as Address[]).includes(announcement));
    const second = await ok(client, "wallet_reclaim", { send: true });
    expect(second).toMatchObject({ closing: last, books: [book], sent: true, next: "closed" });
    expect(h.svm.getAccount(book).exists).toBe(false);
  }, 120_000);

  it("skips a book batch the program refuses on a Ledger and lists it, so the next calls go on and then end", async () => {
    const key = await deviceKey();
    h.svm.airdrop(key.address, lamports(10_000_000_000n));
    const intents = new Map<Address, Address>();
    for (let n = 0; n <= BOOK_BATCH; n++) {
      const planted = await plantBook(key.address);
      h.touched.add(planted.book);
      intents.set(planted.book, planted.intent);
    }
    const plan = await createClient({ url: "http://cluster", transport }).plan.reclaim({ worker: createNoopSigner(key.address) });
    expect(plan.books).toHaveLength(BOOK_BATCH + 1);
    const refused = plan.books.slice(0, BOOK_BATCH).map(({ book }) => book);
    const [lone] = plan.books.slice(BOOK_BATCH).map(({ book }) => book);
    unreadable(intents.get(refused[0] as Address) as Address);
    h.env[ENV_KEYPAIR] = LEDGER_PATH;
    const ledger = device(key, [...found(LEDGER_LEVELS, key), ...transactionThen()]);
    const client = await served(ledger);
    const shown = await ok(client, "wallet_reclaim");
    expect(shown).toMatchObject({ closing: [], books: [lone], unclosed: refused, sent: false });
    const done = await ok(client, "wallet_reclaim", { send: true });
    expect(done).toMatchObject({ books: [lone], unclosed: refused, sent: true, as_previewed: true });
    expect(h.svm.getAccount(lone as Address).exists).toBe(false);
    const after = await ok(client, "wallet_reclaim");
    expect(after).toMatchObject({ closing: [], books: [], unclosed: refused, sent: false, next: BOOKS_REFUSED });
    expect(refused.slice(1).every((book) => h.svm.getAccount(book).exists)).toBe(true);
  }, 120_000);
});
