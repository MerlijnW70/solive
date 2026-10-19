import type { Address } from "@solana/kit";
import { SIGNATURE_PAGE, signaturePage } from "./job-scan.js";
import { type ListedSignature, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const FUNDING_PAGES = 2;
export const FUNDING_READS = 16;
export const FUNDING_HOPS = 2;

export type FundedBy = "yes" | "no" | "unknown";

export type Funder = { funder: Address | null; complete: boolean; busy?: boolean };

export type FundingLookup = (wallet: Address) => Promise<Funder>;

const BUSY = "busy";

async function listedOldestFirst(transport: Transport, wallet: Address): Promise<ListedSignature[] | typeof BUSY | null> {
  const { signaturesOf } = transport;
  if (signaturesOf === undefined) {
    return null;
  }
  const listed: ListedSignature[] = [];
  let before: string | undefined;
  for (let page = 1; page <= FUNDING_PAGES; page++) {
    const found = await signaturePage(transport, signaturesOf, wallet, SIGNATURE_PAGE, before);
    listed.push(...found.listed);
    if (found.last) {
      return listed.filter(({ failed }) => !failed).reverse();
    }
    before = found.listed[found.listed.length - 1]?.signature;
  }
  return BUSY;
}

export async function earliestFunder(transport: Transport, wallet: Address, covered: () => Promise<boolean>): Promise<Funder> {
  try {
    return await readFunder(transport, wallet, covered);
  } catch {
    return { funder: null, complete: false };
  }
}

async function readFunder(transport: Transport, wallet: Address, covered: () => Promise<boolean>): Promise<Funder> {
  const { transactionsOf } = transport;
  const oldest = transactionsOf === undefined ? null : await listedOldestFirst(transport, wallet);
  if (oldest === BUSY) {
    return { funder: null, complete: false, busy: true };
  }
  if (transactionsOf === undefined || oldest === null) {
    return { funder: null, complete: false };
  }
  let reads = 0;
  let at = 0;
  while (at < oldest.length && reads < FUNDING_READS) {
    const batch = oldest.slice(at, at + TRANSACTION_FETCHES);
    at += batch.length;
    const found = await transactionsOf.call(transport, batch);
    if (found.length < batch.length) {
      return { funder: null, complete: false };
    }
    for (const transaction of found) {
      if (transaction.unread === true) {
        return { funder: null, complete: false };
      }
      const into = (transaction.transfers ?? []).filter(({ from, to }) => to === wallet && from !== wallet);
      const funding = into.find(({ lamports }) => lamports > 0n);
      if (funding !== undefined) {
        return { funder: funding.from, complete: await covered() };
      }
      reads += into.length === 0 ? 1 : 0;
    }
  }
  return { funder: null, complete: at >= oldest.length && (await covered()) };
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
    const { funder, complete, busy } = await lookup(wallet);
    if (funder === worker) {
      return "yes";
    }
    if (busy === true && hop > 1) {
      return "no";
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
