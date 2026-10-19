import type { Address } from "@solana/kit";
import { SIGNATURE_PAGE } from "./job-scan.js";
import { type ListedSignature, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const FUNDING_PAGES = 2;
export const FUNDING_READS = 16;
export const FUNDING_HOPS = 2;

export type FundedBy = "yes" | "no" | "unknown";

export type Funder = { funder: Address | null; complete: boolean };

export type FundingLookup = (wallet: Address) => Promise<Funder>;

async function listedOldestFirst(transport: Transport, wallet: Address): Promise<ListedSignature[] | null> {
  const { signaturesOf } = transport;
  if (signaturesOf === undefined) {
    return null;
  }
  const listed: ListedSignature[] = [];
  let before: string | undefined;
  for (let page = 1; page <= FUNDING_PAGES; page++) {
    const found = await signaturesOf.call(transport, wallet, SIGNATURE_PAGE, before);
    listed.push(...found);
    if (found.length < SIGNATURE_PAGE) {
      return listed.filter(({ failed }) => !failed).reverse();
    }
    before = found[found.length - 1]?.signature;
  }
  return null;
}

export async function earliestFunder(transport: Transport, wallet: Address, covered: () => Promise<boolean>): Promise<Funder> {
  const { transactionsOf } = transport;
  const oldest = transactionsOf === undefined ? null : await listedOldestFirst(transport, wallet);
  if (transactionsOf === undefined || oldest === null) {
    return { funder: null, complete: false };
  }
  const reads = oldest.slice(0, FUNDING_READS);
  for (let at = 0; at < reads.length; at += TRANSACTION_FETCHES) {
    const batch = reads.slice(at, at + TRANSACTION_FETCHES);
    const found = await transactionsOf.call(transport, batch);
    if (found.length < batch.length) {
      return { funder: null, complete: false };
    }
    for (const transaction of found) {
      if (transaction.unread === true) {
        return { funder: null, complete: false };
      }
      const into = transaction.transfers?.find(({ from, to, lamports }) => to === wallet && from !== wallet && lamports > 0n);
      if (into !== undefined) {
        return { funder: into.from, complete: await covered() };
      }
    }
  }
  return { funder: null, complete: oldest.length <= FUNDING_READS && (await covered()) };
}

export function fundingLookup(transport: Transport, covered: () => Promise<boolean>): FundingLookup {
  const known = new Map<Address, Promise<Funder>>();
  return (wallet) => {
    const held = known.get(wallet);
    if (held !== undefined) {
      return held;
    }
    const pending = earliestFunder(transport, wallet, covered);
    known.set(wallet, pending);
    return pending;
  };
}

export async function fundedBy(lookup: FundingLookup, payer: Address, worker: Address): Promise<FundedBy> {
  let wallet = payer;
  for (let hop = 1; hop <= FUNDING_HOPS; hop++) {
    const { funder, complete } = await lookup(wallet);
    if (funder === worker) {
      return "yes";
    }
    if (!complete) {
      return "unknown";
    }
    if (funder === null) {
      return "no";
    }
    wallet = funder;
  }
  return "no";
}
