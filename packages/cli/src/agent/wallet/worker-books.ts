import { type Address, getAddressDecoder, type Instruction, type TransactionPartialSigner, type TransactionSigner } from "@solana/kit";
import { IntentStatus } from "@intent-engine/core";
import { buildCloseDeliveryBook } from "@intent-engine/core/internal";
import { BOOK_BATCH, batched, booksPaidBy, intentAt, readBook, unmemoized } from "@intent-engine/client/internal";
import type { Transport } from "@intent-engine/client";
import { execute } from "../../flows.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { preparedView } from "../shapes.js";
import { sol } from "./costs.js";

export { BOOK_BATCH, BOOK_PAYER_AT, booksPaidBy } from "@intent-engine/client/internal";

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

export const bookBatches = (closing: readonly BookClose[]): BookClose[][] => batched(closing, BOOK_BATCH);

export type BatchesClosed<T> = { closed: T[]; unclosed: T[]; signature: string | undefined };

export async function closeEach<T>(transport: Transport, signer: TransactionPartialSigner, batches: readonly (readonly T[])[], instructionOf: (item: T) => Instruction): Promise<BatchesClosed<T>> {
  const done: BatchesClosed<T> = { closed: [], unclosed: [], signature: undefined };
  const closeOf = async (items: readonly T[]): Promise<boolean> => {
    try {
      done.signature = await execute(transport, preparedView(await prepare(unmemoized(transport), items.map(instructionOf), signer.address)), signer);
      done.closed.push(...items);
      return true;
    } catch {
      return false;
    }
  };
  for (const batch of batches) {
    if (await closeOf(batch)) {
      continue;
    }
    for (const item of batch) {
      if (batch.length === 1 || !(await closeOf([item]))) {
        done.unclosed.push(item);
      }
    }
  }
  return done;
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
      book = readBook(data);
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
