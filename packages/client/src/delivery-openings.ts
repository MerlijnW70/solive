import { type Address, getAddressDecoder, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { type JudgeOpening, MAX_OPENED_SALTS, type Opening, openingMemo, type ReleaseRecord } from "@intent-engine/core";
import { type Delivery, type DeliveryRecord, deliveriesIn, deliverySalt, earlier, opensWith, openingsIn, type PublishedOpening, saltCheckOf } from "./job-deliveries.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { memoInstruction, recordedRelease } from "./job-memos.js";
import { type Read, releaseOf, splitClaim } from "./release-reads.js";
import { lifecycleDeliveries } from "./job-origins.js";
import { transactionAt } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type Standing = { valid: boolean; payee: Delivery | null; refutedBy: Delivery | null };

export type ReleaseStanding = { valid: boolean; refutedBy: Signature | null; complete: boolean };

export type StandingTarget = {
  intent: Address;
  attestor: Address;
  release: { slot: bigint };
  recorded: ReleaseRecord;
  payees: readonly Address[] | null;
  createdAt?: bigint | null;
  from?: bigint | null;
};

export type SelfOpeningInput = {
  worker: TransactionSigner;
  intent: Address;
  attestor: Address;
  sha256: string;
  announcement: Signature;
  saltSignature?: Uint8Array;
};

const TOKEN_ACCOUNT_HEAD = 64;

const ordered = (a: Delivery, b: Delivery): number => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0);

const ownSalt = (delivery: Delivery): string | null => (delivery.salt !== "" && saltCheckOf(delivery.salt) === delivery.check ? delivery.salt : null);

export function earlierSalts(deliveries: readonly Delivery[], payee: Delivery): (string | null)[] {
  return deliveries
    .filter((delivery) => delivery.intent === payee.intent && earlier(delivery, payee))
    .sort(ordered)
    .map(ownSalt);
}

export function openingsOf(intent: Address, salts: readonly (string | null)[]): JudgeOpening[] {
  return Array.from({ length: Math.ceil(salts.length / MAX_OPENED_SALTS) }, (_, i) => ({ intent, salts: salts.slice(i * MAX_OPENED_SALTS, (i + 1) * MAX_OPENED_SALTS) }));
}

export function judgeOpenings(deliveries: readonly Delivery[], payee: Delivery): JudgeOpening[] {
  return openingsOf(payee.intent, earlierSalts(deliveries, payee));
}

export function unitedSalts(lists: readonly (readonly (string | null)[])[]): (string | null)[] {
  const length = lists.reduce((most, list) => Math.max(most, list.length), 0);
  return Array.from({ length }, (_, i) => lists.map((list) => list[i] ?? null).find((salt) => salt !== null) ?? null);
}

export function openingInstructions(signer: TransactionSigner, attestor: Address, opening: Opening): Instruction[] {
  const notified = [...new Set([opening.intent, attestor])].filter((to) => to !== signer.address);
  return [
    memoInstruction(signer, openingMemo(opening)),
    ...notified.map((destination) => getTransferSolInstruction({ source: signer, destination, amount: 0n })),
  ];
}

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

export function publishedSalts(delivery: Delivery, openings: readonly PublishedOpening[]): string[] {
  const salts = openings.flatMap(({ opening }): (string | null)[] => {
    if (opening.intent !== delivery.intent) {
      return [];
    }
    return "announcement" in opening ? (opening.announcement === delivery.signature ? [opening.salt] : []) : opening.salts;
  });
  return [...new Set(salts.filter((salt): salt is string => salt !== null && saltCheckOf(salt) === delivery.check))];
}

export function refutingAmong(
  deliveries: readonly Delivery[],
  openings: readonly PublishedOpening[],
  payee: { intent: Address; slot: bigint; signature: string },
  sha256: string,
  paid: readonly Address[],
): Delivery | null {
  let refutedBy: Delivery | null = null;
  for (const delivery of deliveries) {
    const counts = delivery.intent === payee.intent && !paid.includes(delivery.worker) && earlier(delivery, payee);
    if (counts && publishedSalts(delivery, openings).some((open) => opensWith(delivery, open, sha256)) && (refutedBy === null || earlier(delivery, refutedBy))) {
      refutedBy = delivery;
    }
  }
  return refutedBy;
}

export function releaseStanding(
  deliveries: readonly Delivery[],
  openings: readonly PublishedOpening[],
  recorded: ReleaseRecord,
  payees: readonly Address[] | null,
): Standing {
  const { sha256, salt } = recorded;
  let payee: Delivery | null = null;
  for (const delivery of salt === undefined || payees === null ? [] : deliveries) {
    if (opensWith(delivery, salt ?? "", sha256) && payees?.includes(delivery.worker) === true && (payee === null || earlier(delivery, payee))) {
      payee = delivery;
    }
  }
  if (payee === null || payees === null) {
    return { valid: false, payee: null, refutedBy: null };
  }
  const refutedBy = refutingAmong(deliveries, openings, payee, sha256, payees);
  return { valid: true, payee: { ...payee, sha256, salt: salt ?? "" }, refutedBy: refutedBy === null ? null : { ...refutedBy, sha256 } };
}

export type Judged = { attestor: Address; createdAt: bigint | null; to: bigint };

export async function refutedIn(
  transport: Transport,
  transactions: readonly EngineTransaction[],
  payee: { intent: Address; slot: bigint; signature: string },
  sha256: string,
  paid: readonly Address[] = [],
  judged?: Judged,
): Promise<Signature | null> {
  const { intent } = payee;
  const own = openingsIn(transactions, new Set([intent]));
  const named = own.flatMap(({ opening }) => ("announcement" in opening && opening.announcement !== payee.signature ? [opening] : []));
  const fetched: Delivery[] = [];
  for (const opening of named) {
    const announced = await transactionAt(transport, opening.announcement, intent).catch(() => null);
    fetched.push(...(announced === null ? [] : deliveriesIn([announced], new Set([intent]))).filter(({ signature }) => signature === opening.announcement));
  }
  const record =
    judged === undefined
      ? null
      : await lifecycleDeliveries(transport, judged.attestor, { intent, createdAt: judged.createdAt, from: null, to: judged.to }).catch(() => null);
  const deliveries = [...fetched, ...(record?.deliveries ?? [])];
  return refutingAmong(deliveries, [...own, ...(record?.openings ?? [])], payee, sha256, paid)?.signature ?? null;
}

export const notOpened = (announcement: string, worker: Address, intent: Address, sha256: string): string =>
  `the transaction ${announcement} holds no announcement by ${worker} for intent ${intent} that its salt opens to the sha256 ${sha256}; nothing was sent`;

export async function selfOpeningInstructions(transport: Transport, input: SelfOpeningInput): Promise<{ salt: string; instructions: Instruction[] }> {
  const { worker, intent, attestor, announcement } = input;
  const sha256 = input.sha256.toLowerCase();
  const salt = await deliverySalt(worker, intent, sha256, input.saltSignature);
  const announced = await transactionAt(transport, announcement, attestor);
  const own = (announced === null ? [] : deliveriesIn([announced], new Set([intent]))).find(
    (delivery) => delivery.worker === worker.address && opensWith(delivery, salt, sha256),
  );
  if (own === undefined) {
    throw new RangeError(notOpened(announcement, worker.address, intent, sha256));
  }
  return { salt, instructions: openingInstructions(worker, attestor, { intent, announcement, salt }) };
}

export async function releaseStandingOf(transport: Transport, target: StandingTarget): Promise<ReleaseStanding> {
  const { intent, attestor, release, recorded } = target;
  if (recorded.salt === undefined) {
    return { valid: false, refutedBy: null, complete: true };
  }
  const record = await lifecycleDeliveries(transport, attestor, { intent, createdAt: target.createdAt ?? null, from: target.from ?? null, to: release.slot });
  const standing = releaseStanding(record.deliveries, record.openings, recorded, target.payees);
  return { valid: standing.valid, refutedBy: standing.refutedBy?.signature ?? null, complete: record.complete };
}

export type RecordedStanding = { signature: Signature; sha256: string; salt?: string; valid: boolean; refutedBy: Signature | null };

export async function recordedStanding(transport: Transport, intent: Address, record: DeliveryRecord, history: number = HISTORY_LIMIT): Promise<RecordedStanding | null> {
  const transactions = await transport.engineTransactions(history, intent);
  const release = releaseOf(transactions, intent);
  if (release === undefined || (release.event.name !== "IntentAttested" && release.event.name !== "IntentSplit")) {
    return null;
  }
  const recorded = recordedRelease(transactions, release.transaction, release.event.fields.attestor);
  if (recorded === null) {
    return null;
  }
  const payees = await paidWalletsOf(transport, release, intent);
  const standing = releaseStanding(record.deliveries, [...record.openings, ...openingsIn(transactions, new Set([intent]))], recorded, payees);
  return {
    signature: release.transaction.signature as Signature,
    ...recorded,
    valid: standing.valid,
    refutedBy: standing.refutedBy?.signature ?? null,
  };
}

export async function releaseStandingAt(
  transport: Transport,
  intent: Address,
  signature: string,
  created: { createdAt: bigint | null; from: bigint | null },
  history: number = HISTORY_LIMIT,
): Promise<ReleaseStanding | null> {
  const transactions = await transport.engineTransactions(history, intent);
  const release = releaseOf(
    transactions.filter((transaction) => transaction.signature === signature),
    intent,
  );
  if (release === undefined || (release.event.name !== "IntentAttested" && release.event.name !== "IntentSplit")) {
    return null;
  }
  const recorded = recordedRelease(transactions, release.transaction, release.event.fields.attestor);
  if (recorded === null) {
    return null;
  }
  const payees = await paidWalletsOf(transport, release, intent);
  return releaseStandingOf(transport, { intent, attestor: release.event.fields.attestor, release: release.transaction, recorded, payees, ...created });
}
