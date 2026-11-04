import { type Address, getAddressDecoder, getAddressEncoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { IntentStatus } from "@intent-engine/core";
import { buildCloseDeliveryBook, decodeDeliveryBookAccount, DELIVERY_BOOK_DISCRIMINATOR, getDeliveryBookSize } from "@intent-engine/core/internal";
import { intentAt } from "@intent-engine/client/internal";
import type { EngineAccount, Transport } from "@intent-engine/client";
import { tool } from "../names.js";
import { sol } from "./costs.js";

export const BOOK_PAYER_AT = 40;

export const BOOK_BATCH = 6;

export const ANNOUNCEMENT_INTENT_AT = 8;

export const BOOKS_UNLISTED = "this RPC node cannot list the delivery books the worker paid for, so the key stays";

export const BOOK_ESCROW_OPEN = "its escrow is still open";

export const bookUnread = (book: Address, keypair: string): string => `the delivery book ${book} the worker paid for cannot be read, so it stays; its key file is ${keypair}`;

export const bookLive = (live: bigint): string => `${live} of its announcements are not closed yet`;

export const bookKept = (book: Address, intent: Address, rent: bigint, why: string, keypair: string): string =>
  `the delivery book ${book} of escrow ${intent} holds ${sol(rent)} of rent the worker paid and cannot close yet, since ${why}; once it can, ${tool("wallet_worker")} with return_leftovers closes it; its key file is ${keypair}`;

export const bookUnclosed = (book: Address, keypair: string): string =>
  `the delivery book ${book} the worker paid for was refused when it closed, so it stays; ${tool("wallet_worker")} with return_leftovers tries again; its key file is ${keypair}`;

export const booksClosed = (books: readonly Address[], rent: bigint): string =>
  `Closes: the delivery book${books.length === 1 ? "" : "s"} ${books.join(", ")} the worker paid for, returning ${sol(rent)} of rent to this wallet`;

export const booksKeptLine = (keypair: string, books: readonly Address[]): string =>
  `Keeps: ${keypair}, since the delivery book${books.length === 1 ? "" : "s"} ${books.join(", ")} the worker paid for cannot close yet`;

export type BookClose = { book: Address; instruction: Instruction; rent: bigint };

export type Books = { closing: BookClose[]; open: Address[]; kept: string[] };

export const rentOf = (closing: readonly BookClose[]): bigint => closing.reduce((sum, { rent }) => sum + rent, 0n);

export function bookBatches(closing: readonly BookClose[]): BookClose[][] {
  const batches: BookClose[][] = [];
  for (let at = 0; at < closing.length; at += BOOK_BATCH) {
    batches.push(closing.slice(at, at + BOOK_BATCH));
  }
  return batches;
}

const payerIs = (data: Uint8Array, worker: Address): boolean => {
  const bytes = getAddressEncoder().encode(worker);
  return data.length >= BOOK_PAYER_AT + bytes.length && bytes.every((b, i) => data[BOOK_PAYER_AT + i] === b);
};

export async function booksPaidBy(transport: Transport, worker: Address): Promise<EngineAccount[] | null> {
  if (transport.engineAccounts === undefined) {
    return null;
  }
  const found = await transport.engineAccounts({ discriminator: DELIVERY_BOOK_DISCRIMINATOR, dataSize: getDeliveryBookSize(), match: [{ offset: BOOK_PAYER_AT, address: worker }] });
  return found.filter(({ data }) => payerIs(data, worker));
}

export const intentsOf = (announcements: readonly ({ data: Uint8Array } | null | undefined)[]): Address[] =>
  announcements.flatMap((view) =>
    view === null || view === undefined || view.data.length < ANNOUNCEMENT_INTENT_AT + 32 ? [] : [getAddressDecoder().decode(view.data.subarray(ANNOUNCEMENT_INTENT_AT, ANNOUNCEMENT_INTENT_AT + 32))],
  );

const openAt = async (transport: Transport, intent: Address, now: bigint): Promise<boolean> => {
  const held = await intentAt(transport, intent);
  return held !== null && held.status === IntentStatus.Open && now < held.expiresAt;
};

export async function booksOf(transport: Transport, worker: Address, key: TransactionSigner, closing: readonly Address[], now: bigint, keypair: string): Promise<Books> {
  const books: Books = { closing: [], open: [], kept: [] };
  const found = await booksPaidBy(transport, worker);
  if (found === null) {
    return { ...books, kept: [BOOKS_UNLISTED] };
  }
  for (const { address, data, lamports } of found) {
    let book;
    try {
      book = decodeDeliveryBookAccount(data);
    } catch {
      books.open.push(address);
      books.kept.push(bookUnread(address, keypair));
      continue;
    }
    const left = book.live - BigInt(closing.filter((intent) => intent === book.intent).length);
    const why = (await openAt(transport, book.intent, now)) ? BOOK_ESCROW_OPEN : left > 0n ? bookLive(left) : undefined;
    if (why !== undefined) {
      books.open.push(address);
      books.kept.push(bookKept(address, book.intent, lamports, why, keypair));
      continue;
    }
    books.closing.push({ book: address, instruction: await buildCloseDeliveryBook({ by: key, intent: book.intent, rentTo: worker }), rent: lamports });
  }
  return books;
}
