import type { Address } from "@solana/kit";
import {
  decodeEvent,
  type EngineEvent,
  FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getFillAttestedSplitInstructionDataDecoder,
  RELEASE_MEMO_PREFIX,
} from "@intent-engine/core";
import { engineCalls } from "./job-origins.js";
import { scan, signaturePage } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

const SPLIT_INTENT_ACCOUNT = 2;

const startsWith = (data: Uint8Array, head: ArrayLike<number>): boolean =>
  data.length >= head.length && Array.from(head).every((b, i) => data[i] === b);

export function splitClaim(release: EngineTransaction, intent: Address) {
  for (const { data, accounts } of engineCalls(release)) {
    if (accounts?.[SPLIT_INTENT_ACCOUNT] !== intent) {
      continue;
    }
    try {
      if (startsWith(data, FILL_ATTESTED_SPLIT_DISCRIMINATOR)) {
        return getFillAttestedSplitInstructionDataDecoder().decode(data).claim;
      }
      if (startsWith(data, FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR)) {
        return getFillAttestedSplitCommitteeInstructionDataDecoder().decode(data).claim;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type Read = { event: EngineEvent; transaction: EngineTransaction };

export function eventsOf(transactions: readonly EngineTransaction[], intent?: Address): Read[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap((transaction) =>
      transaction.emitted
        .map((data) => decodeEvent(data) as EngineEvent | null)
        .filter((event): event is EngineEvent => event !== null && "intent" in event.fields && (intent === undefined || event.fields.intent === intent))
        .map((event) => ({ event, transaction })),
    );
}

export function releaseOf(transactions: readonly EngineTransaction[], intent: Address): Read | undefined {
  return eventsOf(transactions, intent).find(({ event }) => event.name === "IntentAttested" || event.name === "IntentSplit");
}

export const INTENT_HISTORY_PAGES = 10;

export type IntentHistory = { transactions: EngineTransaction[]; complete: boolean };

const createdIn = (transactions: readonly EngineTransaction[], intent: Address): boolean =>
  eventsOf(transactions, intent).some(({ event }) => event.name === "IntentCreated");

export async function intentHistory(transport: Transport, intent: Address, history: number): Promise<IntentHistory> {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    const first = await transport.engineTransactions(history, intent);
    return { transactions: first, complete: first.length < history || createdIn(first, intent) };
  }
  const transactions: EngineTransaction[] = [];
  let before: string | undefined;
  for (let page = 1; page <= INTENT_HISTORY_PAGES; page++) {
    const { listed, last } = await signaturePage(transport, signaturesOf, intent, history, before);
    const found = await transactionsOf.call(transport, listed);
    transactions.push(...found);
    if (last || createdIn(found, intent)) {
      return { transactions, complete: true };
    }
    before = listed[listed.length - 1]?.signature;
  }
  return { transactions, complete: false };
}

export async function releaseThrough(transport: Transport, intent: Address, wallets: readonly Address[], pages: number, floor: bigint | null): Promise<EngineTransaction[]> {
  for (const wallet of wallets) {
    const until = (transaction: EngineTransaction) => releaseOf([transaction], intent) !== undefined;
    const found = await scan(transport, wallet, { floor, memo: RELEASE_MEMO_PREFIX, pages, until });
    const release = found.transactions.filter((transaction) => releaseOf([transaction], intent) !== undefined);
    if (release.length > 0) {
      return release;
    }
  }
  return [];
}
