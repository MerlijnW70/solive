import type { Address } from "@solana/kit";
import { type EngineTransaction, type ListedSignature, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const DELIVERY_SCAN = 100;
export const DELIVERY_PAGES = 100;
export const SIGNATURE_PAGE = 1000;
export const MEMOS_PER_TRANSACTION = 8;

export type Scan = { transactions: EngineTransaction[]; complete: boolean; pages: number };

export type ScanOptions = {
  floor?: bigint | null;
  memo?: string;
  pages?: number;
  until?: (transaction: EngineTransaction) => boolean;
  covered?: () => Promise<boolean>;
};

const memoMatches = (memo: string | undefined, texts: readonly string[]): boolean => memo === undefined || texts.some((text) => text.includes(memo));

const reaches = (floor: bigint | null) => ({ blockTime }: { blockTime: bigint | null }): boolean => floor === null || blockTime === null || blockTime >= floor;

async function fallbackScan(transport: Transport, of: Address, options: ScanOptions): Promise<Scan> {
  const { floor = null, memo, until, covered } = options;
  const found = await transport.engineTransactions(DELIVERY_SCAN, of);
  const within = found.filter(reaches(floor));
  const transactions: EngineTransaction[] = [];
  for (const transaction of within) {
    if (transaction.failed || !memoMatches(memo, transaction.memos ?? [])) {
      continue;
    }
    transactions.push(transaction);
    if (until?.(transaction) === true) {
      return { transactions, complete: true, pages: 1 };
    }
  }
  if (within.length < found.length) {
    return { transactions, complete: true, pages: 1 };
  }
  return { transactions, complete: found.length < DELIVERY_SCAN && (await covered?.()) === true, pages: 1 };
}

export async function scan(transport: Transport, of: Address, options: ScanOptions = {}): Promise<Scan> {
  const { floor = null, memo, pages = DELIVERY_PAGES, until, covered } = options;
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    return fallbackScan(transport, of, options);
  }
  const transactions: EngineTransaction[] = [];
  let before: string | undefined;
  let next: ListedSignature[] | undefined;
  for (let page = 1; page <= pages; page++) {
    const listed = next ?? (await signaturesOf.call(transport, of, SIGNATURE_PAGE, before));
    next = undefined;
    const within = listed.filter(reaches(floor));
    const wanted = within.filter((entry: ListedSignature) => !entry.failed && memoMatches(memo, entry.memo === null ? [] : [entry.memo]));
    for (let at = 0; at < wanted.length; at += TRANSACTION_FETCHES) {
      for (const transaction of await transactionsOf.call(transport, wanted.slice(at, at + TRANSACTION_FETCHES))) {
        transactions.push(transaction);
        if (until?.(transaction) === true) {
          return { transactions, complete: true, pages: page };
        }
      }
    }
    if (within.length < listed.length) {
      return { transactions, complete: true, pages: page };
    }
    before = listed[listed.length - 1]?.signature;
    if (listed.length < SIGNATURE_PAGE) {
      const more = before === undefined ? [] : await signaturesOf.call(transport, of, SIGNATURE_PAGE, before);
      if (more.length === 0) {
        return { transactions, complete: (await covered?.()) === true, pages: page };
      }
      next = more;
    }
  }
  return { transactions, complete: false, pages };
}

export async function transactionAt(transport: Transport, signature: string, of?: Address): Promise<EngineTransaction | null> {
  const { transactionOf } = transport;
  if (transactionOf !== undefined) {
    return transactionOf.call(transport, signature);
  }
  return (await transport.engineTransactions(DELIVERY_SCAN, of)).find((transaction) => transaction.signature === signature) ?? null;
}
