import { type Address, getAddressEncoder, getBase64Encoder } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_LAYOUTS, decodeDeliveryBookAccount, deliveryBookAddress } from "@intent-engine/core/internal";
import { announcementsBy } from "@intent-engine/client/internal";
import { testSignature } from "@intent-engine/client/testing";
import { BOOK_ESCROW_OPEN, bookKept, bookLive, booksClosed, booksKeptLine, bookUnclosed, bookUnread } from "../src/agent/wallet/worker-books.js";
import { h, NOW, setNow } from "./harness.js";
import { approved, UNJUDGED } from "./approved.js";
import { commandNamed, hireWith, lamportsOf, makeWorker, ok, plantBook, removeWorkFiles, run, server, sha, SOLUTION, startHirer, workFile } from "./local-worker-kit.js";

const REFUTE_WINDOW = 30n * 86_400n;

const PACKET_BYTES = 1232;

const MANY_BOOKS = 30;

const BOOK_VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find(({ name }) => name === "delivery book")?.versionAt ?? 0);

const holds = (wire: Uint8Array, address: Address) => {
  const bytes = getAddressEncoder().encode(address);
  return wire.some((_, at) => bytes.every((byte, i) => wire[at + i] === byte));
};


describe("a local worker's delivery book", () => {
  let hirer: Client;
  let wallet: Address;

  const deliver = async (brief: string) => {
    const artifact = workFile(SOLUTION);
    await run(commandNamed(brief, "deliver").map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>"));
  };

  const announced = async () => {
    const job = await hireWith(hirer, wallet, false);
    const made = await makeWorker(hirer, job.intent);
    await deliver(made.brief);
    const book = await deliveryBookAddress(job.intent);
    return { ...job, ...made, book, rent: lamportsOf(book) };
  };

  const bookOf = (book: Address) => {
    const view = h.svm.getAccount(book);
    return view.exists ? decodeDeliveryBookAccount(view.data) : null;
  };

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("closes the book the worker paid for once its job ended, returns its rent to this wallet, and only then deletes the key", async () => {
    const job = await announced();
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 1n });
    expect(job.rent).toBeGreaterThan(0n);
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: job.worker });
    expect(preview["summary"]).toContain(booksClosed([job.book], job.rent));
    expect(preview["kept"]).toEqual([]);
    const held = lamportsOf(job.worker);
    const before = lamportsOf(wallet);
    const done = await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: true });
    expect(bookOf(job.book)).toBeNull();
    expect(lamportsOf(job.worker)).toBe(0n);
    expect(lamportsOf(wallet) - before).toBeGreaterThan(held + job.rent - 100_000n);
    expect(h.files.has(job.keypair)).toBe(false);
  }, 60_000);

  it("keeps the key and lists the book while a paid announcement holds it, and closes both once the refute window passed", async () => {
    const job = await announced();
    const paid = await ok(hirer, "wallet_attest", await approved(hirer, "wallet_attest", { ...UNJUDGED, owner: wallet, nonce: job.nonce, delivered_sha256: sha(SOLUTION) }));
    expect(paid).toMatchObject({ sent: true, pay_to: job.worker });
    const kept = bookKept(job.book, job.intent, job.rent, bookLive(1n), job.keypair);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: job.worker });
    expect(preview["kept"]).toContain(kept);
    expect(preview["summary"]).toContain(booksKeptLine(job.keypair, [job.book]));
    const done = await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"]).toContain(kept);
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 1n });
    expect(h.files.has(job.keypair)).toBe(true);
    setNow(NOW + REFUTE_WINDOW + 600n);
    const later = await ok(hirer, "wallet_worker", { return_leftovers: job.worker });
    expect(later["summary"]).toContain(booksClosed([job.book], job.rent));
    expect(await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(bookOf(job.book)).toBeNull();
    expect(lamportsOf(job.worker)).toBe(0n);
    expect(h.files.has(job.keypair)).toBe(false);
  }, 120_000);

  it("never deletes the key while another worker's announcement keeps the book it paid for open", async () => {
    const job = await announced();
    const second = await makeWorker(hirer, job.intent);
    await deliver(second.brief);
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 2n });
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const kept = bookKept(job.book, job.intent, job.rent, bookLive(1n), job.keypair);
    const first = await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true });
    expect(first).toMatchObject({ sent: true, key_deleted: false });
    expect(first["kept"]).toContain(kept);
    expect(first["summary"]).toContain(booksKeptLine(job.keypair, [job.book]));
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 1n });
    expect(h.files.has(job.keypair)).toBe(true);
    expect(await ok(hirer, "wallet_worker", { return_leftovers: second.worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(bookOf(job.book)).toMatchObject({ live: 0n });
    expect(h.files.has(job.keypair)).toBe(true);
    expect(await ok(hirer, "wallet_worker", { return_leftovers: job.worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(bookOf(job.book)).toBeNull();
    expect(lamportsOf(job.worker)).toBe(0n);
    expect(h.files.has(job.keypair)).toBe(false);
  }, 120_000);

  it("still returns the SOL when a book's close is refused, and keeps the key with that book listed", async () => {
    const job = await announced();
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const live = h.through as NonNullable<typeof h.through>;
    const [announcement] = (await announcementsBy(live, job.worker)).announcements;
    let refused = 0;
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        const bytes = Uint8Array.from(getBase64Encoder().encode(wire));
        if (holds(bytes, job.book) && !holds(bytes, announcement?.address as Address)) {
          refused += 1;
          throw new Error("the node refused it");
        }
        return live.sendWire(wire, latest);
      },
    };
    const refusing = await server();
    const before = lamportsOf(wallet);
    const held = lamportsOf(job.worker);
    const done = await ok(refusing, "wallet_worker", { return_leftovers: job.worker, send: true });
    expect(refused).toBe(1);
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"]).toEqual([bookUnclosed(job.book, job.keypair)]);
    expect(done["summary"]).toContain(booksKeptLine(job.keypair, [job.book]));
    expect(done["summary"].join(" ")).not.toContain("Closes:");
    expect(lamportsOf(job.worker)).toBe(0n);
    expect(lamportsOf(wallet) - before).toBeGreaterThan(held - 100_000n);
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 0n });
    expect(h.files.has(job.keypair)).toBe(true);
  }, 60_000);

  it("closes more books than fit one transaction in batches, and returns all their rent", async () => {
    const job = await hireWith(hirer, wallet, false);
    const made = await makeWorker(hirer, job.intent);
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const planted = [];
    for (let n = 0; n < MANY_BOOKS; n += 1) {
      planted.push(await plantBook(made.worker));
    }
    const rent = planted.reduce((sum, { rent }) => sum + rent, 0n);
    const live = h.through as NonNullable<typeof h.through>;
    const sizes: number[] = [];
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        sizes.push(getBase64Encoder().encode(wire).length);
        return live.sendWire(wire, latest);
      },
    };
    const counting = await server();
    const held = lamportsOf(made.worker);
    const before = lamportsOf(wallet);
    const done = await ok(counting, "wallet_worker", { return_leftovers: made.worker, send: true });
    expect(done).toMatchObject({ sent: true, kept: [], key_deleted: true });
    expect(sizes.length).toBeGreaterThan(2);
    expect(sizes.every((size) => size <= PACKET_BYTES)).toBe(true);
    expect(planted.every(({ book }) => bookOf(book) === null)).toBe(true);
    expect(lamportsOf(made.worker)).toBe(0n);
    expect(lamportsOf(wallet) - before).toBeGreaterThan(held + rent - 100_000n);
    expect(h.files.has(made.keypair)).toBe(false);
  }, 60_000);

  it("keeps the key and names the open escrow when the worker paid the book of another escrow still open", async () => {
    const own = await hireWith(hirer, wallet, false);
    const other = await hireWith(hirer, wallet, false);
    const made = await makeWorker(hirer, own.intent);
    const artifact = workFile(SOLUTION);
    await run(commandNamed(made.brief, "deliver").map((word, at, args) => (word === "<your" ? artifact : args[at - 1] === "--intent" ? other.intent : word)).filter((word) => word !== "file>"));
    const book = await deliveryBookAddress(other.intent);
    expect(bookOf(book)).toMatchObject({ payer: made.worker, live: 1n });
    await ok(hirer, "wallet_cancel", { nonce: own.nonce, close: false, send: true });
    const done = await ok(hirer, "wallet_worker", { return_leftovers: made.worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"]).toContain(bookKept(book, other.intent, lamportsOf(book), BOOK_ESCROW_OPEN, made.keypair));
    expect(bookOf(book)).toMatchObject({ payer: made.worker, live: 1n });
    expect(h.files.has(made.keypair)).toBe(true);
  }, 60_000);

  it("keeps the key and lists a book it paid for that cannot be read", async () => {
    const job = await hireWith(hirer, wallet, false);
    const made = await makeWorker(hirer, job.intent);
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const { book } = await plantBook(made.worker);
    const view = h.svm.getAccount(book);
    if (!view.exists) {
      throw new Error("the book is gone");
    }
    const broken = Uint8Array.from(view.data);
    broken[BOOK_VERSION_AT] = 255;
    h.svm.setAccount({ ...view, data: broken });
    const done = await ok(hirer, "wallet_worker", { return_leftovers: made.worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"]).toEqual([bookUnread(book, made.keypair)]);
    expect(done["summary"]).toContain(booksKeptLine(made.keypair, [book]));
    expect(h.svm.getAccount(book).exists).toBe(true);
    expect(lamportsOf(made.worker)).toBe(0n);
    expect(h.files.has(made.keypair)).toBe(true);
  }, 60_000);

  it("reads the books again before deleting the key, and keeps it when the book's close did not land", async () => {
    const job = await announced();
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const live = h.through as NonNullable<typeof h.through>;
    const [announcement] = (await announcementsBy(live, job.worker)).announcements;
    expect(announcement?.intent).toBe(job.intent);
    const dropped: string[] = [];
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        const bytes = Uint8Array.from(getBase64Encoder().encode(wire));
        if (holds(bytes, job.book) && !holds(bytes, announcement?.address as Address)) {
          dropped.push(wire);
          return testSignature("dropped");
        }
        return live.sendWire(wire, latest);
      },
    };
    const dropping = await server();
    const done = await ok(dropping, "wallet_worker", { return_leftovers: job.worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(dropped).toHaveLength(1);
    expect(h.svm.getAccount(announcement?.address as Address).exists).toBe(false);
    expect(bookOf(job.book)).toMatchObject({ payer: job.worker, live: 0n });
    expect(h.files.has(job.keypair)).toBe(true);
  }, 60_000);
});
