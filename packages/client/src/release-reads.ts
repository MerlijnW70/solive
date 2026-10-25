import { type Address, getAddressDecoder } from "@solana/kit";
import { type EngineEvent } from "@intent-engine/core";
import {
  decodeEvent,
  findEventAuthorityPda,
  FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getFillAttestedSplitInstructionDataDecoder,
} from "@intent-engine/core/internal";
import { engineCalls } from "./job-origins.js";
import { signaturePage } from "./job-scan.js";
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

let authority: Promise<Address> | undefined;

export function eventAuthority(): Promise<Address> {
  authority ??= findEventAuthorityPda().then(([address]) => address);
  return authority;
}

const emittedThrough = (accounts: readonly Address[] | undefined, by: Address): boolean => accounts?.length === 1 && accounts[0] === by;

export function engineEvents(transactions: readonly EngineTransaction[], by: Address, intent?: Address): Read[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap((transaction) =>
      transaction.emitted.flatMap((data, i): Read[] => {
        if (!emittedThrough(transaction.emittedAccounts?.[i], by)) {
          return [];
        }
        const event = decodeEvent(data) as EngineEvent | null;
        return event !== null && "intent" in event.fields && (intent === undefined || event.fields.intent === intent) ? [{ event, transaction }] : [];
      }),
    );
}

export type Settled = Extract<EngineEvent, { name: "IntentAttested" | "IntentSplit" }>;

export type DeliveryReleasedFields = Extract<EngineEvent, { name: "DeliveryReleased" }>["fields"];

export type Settlement = { transaction: EngineTransaction; settled: Settled; released: DeliveryReleasedFields };

export function settlementIn(transaction: EngineTransaction, by: Address, intent: Address): Settlement | null {
  const events = engineEvents([transaction], by, intent).map(({ event }) => event);
  const settled = events.find((event): event is Settled => event.name === "IntentAttested" || event.name === "IntentSplit");
  const released = events.find((event) => event.name === "DeliveryReleased");
  return settled === undefined || released?.name !== "DeliveryReleased" ? null : { transaction, settled, released: released.fields };
}

export function releaseOf(transactions: readonly EngineTransaction[], intent: Address): Read | undefined {
  return eventsOf(transactions, intent).find(({ event }) => event.name === "IntentAttested" || event.name === "IntentSplit");
}

export const INTENT_HISTORY_PAGES = 10;

export type IntentHistory = { transactions: EngineTransaction[]; complete: boolean };

const createdIn = (transactions: readonly EngineTransaction[], intent: Address): boolean =>
  eventsOf(transactions, intent).some(({ event }) => event.name === "IntentCreated");

type Enough = (found: readonly EngineTransaction[]) => boolean;

export async function intentHistory(transport: Transport, intent: Address, history: number, enough: Enough = () => false): Promise<IntentHistory> {
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    const first = await transport.engineTransactions(history, intent);
    return { transactions: first, complete: first.length < history || createdIn(first, intent) || enough(first) };
  }
  const transactions: EngineTransaction[] = [];
  let before: string | undefined;
  for (let page = 1; page <= INTENT_HISTORY_PAGES; page++) {
    const { listed, last } = await signaturePage(transport, signaturesOf, intent, history, before);
    const found = await transactionsOf.call(transport, listed);
    transactions.push(...found);
    if (last || createdIn(found, intent) || enough(found)) {
      return { transactions, complete: true };
    }
    before = listed[listed.length - 1]?.signature;
  }
  return { transactions, complete: false };
}

const TOKEN_ACCOUNT_HEAD = 64;

export async function paidWalletsOf(transport: Transport, { event, transaction }: Read, intent: Address): Promise<Address[] | null> {
  if (event.name === "IntentSplit") {
    const claim = splitClaim(transaction, intent);
    return claim === null ? null : [...claim.recipients];
  }
  if (event.name !== "IntentAttested") {
    return null;
  }
  const payee = event.fields.payee;
  const recorded = transaction.tokens?.find(({ account }) => account === payee)?.owner;
  if (recorded !== undefined) {
    return [recorded];
  }
  const held = await transport.getAccount(payee);
  return held === null || held.data.length < TOKEN_ACCOUNT_HEAD ? null : [getAddressDecoder().decode(held.data.subarray(32, TOKEN_ACCOUNT_HEAD))];
}

export type ReleasedDelivery = { announcement: Address; seq: bigint; worker: Address; sha256: string; salt: string };

const hexOf = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function releasedDelivery(release: EngineTransaction, intent: Address): ReleasedDelivery | null {
  for (const { event } of eventsOf([release], intent)) {
    if (event.name === "DeliveryReleased") {
      const { announcement, seq, worker, delivered, salt } = event.fields;
      return { announcement, seq, worker, sha256: hexOf(delivered), salt: hexOf(salt) };
    }
  }
  return null;
}
