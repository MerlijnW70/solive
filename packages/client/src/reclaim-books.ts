import { type Address, getAddressEncoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { IntentStatus } from "@intent-engine/core";
import { buildCloseDeliveryBook, DELIVERY_BOOK_DISCRIMINATOR, deliveryBookAddress, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { BOOK_SIZES, readBook } from "./fair-reads.js";
import { readableIntent } from "./job-proofs.js";
import type { EngineAccount } from "./rpc-shapes.js";
import type { Transport } from "./transport.js";

export const BOOK_BATCH = 6;

export const BOOK_PAYER_AT = 40;

export type ReclaimBook = { book: Address; intent: Address; rentTo: Address; rent: bigint; after: Address[]; instruction: Instruction };

export type ClosingAnnouncement = { address: Address; intent: Address };

export function batched<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    batches.push(items.slice(at, at + size));
  }
  return batches;
}

const payerIs = (data: Uint8Array, payer: Address): boolean => {
  const bytes = getAddressEncoder().encode(payer);
  return data.length >= BOOK_PAYER_AT + bytes.length && bytes.every((b, i) => data[BOOK_PAYER_AT + i] === b);
};

export async function booksPaidBy(transport: Transport, payer: Address): Promise<EngineAccount[] | null> {
  if (transport.engineAccounts === undefined) {
    return null;
  }
  const scan = transport.engineAccounts.bind(transport);
  const found = await Promise.all(BOOK_SIZES.map((dataSize) => scan({ discriminator: DELIVERY_BOOK_DISCRIMINATOR, dataSize, match: [{ offset: BOOK_PAYER_AT, address: payer }] })));
  return found.flat().filter(({ data }) => payerIs(data, payer));
}

const isBook = (view: { owner: Address; data: Uint8Array }): boolean =>
  view.owner === INTENT_ENGINE_PROGRAM_ADDRESS && DELIVERY_BOOK_DISCRIMINATOR.every((b, i) => view.data[i] === b);

type Found = { address: Address; data: Uint8Array; lamports: bigint };

async function candidates(transport: Transport, intents: readonly Address[], payers: readonly Address[]): Promise<Found[]> {
  const addresses = await Promise.all(intents.map(deliveryBookAddress));
  const [views, listed] = await Promise.all([transport.getAccounts(addresses), Promise.all(payers.map((payer) => booksPaidBy(transport, payer).catch(() => null)))]);
  const found = new Map<Address, Found>();
  addresses.forEach((address, i) => {
    const view = views[i];
    if (view !== null && view !== undefined && isBook(view)) {
      found.set(address, { address, data: view.data, lamports: view.lamports });
    }
  });
  for (const { address, data, lamports } of listed.flatMap((one) => one ?? [])) {
    if (!found.has(address)) {
      found.set(address, { address, data, lamports });
    }
  }
  return [...found.values()];
}

export async function closableBooks(
  transport: Transport,
  by: TransactionSigner,
  closing: readonly ClosingAnnouncement[],
  payers: readonly Address[],
  now: bigint,
): Promise<ReclaimBook[]> {
  const after = new Map<Address, Address[]>();
  for (const { address, intent } of closing) {
    after.set(intent, [...(after.get(intent) ?? []), address]);
  }
  const decoded = (await candidates(transport, [...after.keys()], payers)).flatMap((found) => {
    try {
      return [{ ...found, stored: readBook(found.data) }];
    } catch {
      return [];
    }
  });
  const intents = decoded.map(({ stored }) => stored.intent);
  const views = await transport.getAccounts(intents);
  const books: ReclaimBook[] = [];
  for (const [i, { address, lamports, stored }] of decoded.entries()) {
    const view = views[i];
    const intent = view === null || view === undefined || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS ? null : readableIntent(view.data);
    const open = intent !== null && intent.status === IntentStatus.Open && now < intent.expiresAt;
    const first = after.get(stored.intent) ?? [];
    if (open || address !== (await deliveryBookAddress(stored.intent)) || stored.live !== BigInt(first.length)) {
      continue;
    }
    books.push({ book: address, intent: stored.intent, rentTo: stored.payer, rent: lamports, after: first, instruction: await buildCloseDeliveryBook({ by, intent: stored.intent, rentTo: stored.payer }) });
  }
  return books;
}
