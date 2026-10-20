import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  decodeParams,
  getCreateIntentArgsDecoder,
  getCreateIntentByAgentDiscriminatorBytes,
  getCreateIntentDiscriminatorBytes,
  getCreateIntentSignedDiscriminatorBytes,
  Kind,
} from "@intent-engine/core";
import { type DeliveryOpeners, type DeliveryRecord, judgedDeliveries } from "./job-deliveries.js";
import { createdAtOf, createdIn, hex } from "./job-proofs.js";
import { DELIVERY_PAGES, scan } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type EscrowProof = { attestor: Address; specHash: string };

export type EscrowOrigin = { intent: Address; signature: string; slot: bigint; createdAt: bigint | null; proof: EscrowProof | null };

const CREATE_DISCRIMINATORS: readonly ReadonlyUint8Array[] = [
  getCreateIntentDiscriminatorBytes(),
  getCreateIntentByAgentDiscriminatorBytes(),
  getCreateIntentSignedDiscriminatorBytes(),
];

const DISCRIMINATOR_BYTES = 8;

export type EngineCall = { data: Uint8Array; accounts: Address[] | undefined; inner: boolean };

export function engineCalls(transaction: EngineTransaction): EngineCall[] {
  return [
    ...(transaction.called ?? []).map((data, i) => ({ data, accounts: transaction.calledAccounts?.[i], inner: false })),
    ...transaction.emitted.map((data, i) => ({ data, accounts: transaction.emittedAccounts?.[i], inner: true })),
  ];
}

const startsWith = (data: Uint8Array, head: ReadonlyUint8Array): boolean => data.length >= head.length && head.every((b, i) => data[i] === b);

export function creationProof(transaction: EngineTransaction, intent: Address): EscrowProof | null {
  for (const { data, accounts } of engineCalls(transaction)) {
    if (!CREATE_DISCRIMINATORS.some((head) => startsWith(data, head)) || accounts === undefined || !accounts.includes(intent)) {
      continue;
    }
    try {
      const args = getCreateIntentArgsDecoder().decode(data, DISCRIMINATOR_BYTES);
      const params = decodeParams(args.kind, Uint8Array.from(args.params));
      return params.kind === Kind.AttestedResult ? { attestor: params.attestor, specHash: hex(params.specHash) } : null;
    } catch {
      continue;
    }
  }
  return null;
}

export async function escrowOrigin(transport: Transport, intent: Address, pages: number = DELIVERY_PAGES): Promise<EscrowOrigin | null> {
  const floor = await createdAtOf(transport, intent);
  const created = (transaction: EngineTransaction) => !transaction.failed && createdIn(transaction.emitted, intent);
  const { transactions } = await scan(transport, intent, { floor, pages, until: created });
  const tx = transactions.find(created);
  return tx === undefined ? null : { intent, signature: tx.signature, slot: tx.slot, createdAt: floor ?? tx.blockTime, proof: creationProof(tx, intent) };
}

export async function originDeliveries(transport: Transport, judge: Address, origin: EscrowOrigin, pages: number = DELIVERY_PAGES): Promise<DeliveryRecord> {
  const { firstAvailableSlot } = transport;
  const covered = async () => firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) <= origin.slot;
  return judgedDeliveries(transport, judge, new Set([origin.intent]), origin.createdAt, covered, pages);
}

export type Lifecycle = { intent: Address; createdAt: bigint | null; from: bigint | null; to: bigint };

export async function lifecycleDeliveries(
  transport: Transport,
  judge: Address,
  lifecycle: Lifecycle,
  pages: number = DELIVERY_PAGES,
  keypair?: DeliveryOpeners,
): Promise<DeliveryRecord> {
  const { firstAvailableSlot } = transport;
  const { from, to } = lifecycle;
  const covered = async () => from !== null && firstAvailableSlot !== undefined && (await firstAvailableSlot.call(transport)) <= from;
  const record = await judgedDeliveries(transport, judge, new Set([lifecycle.intent]), lifecycle.createdAt, covered, pages, keypair);
  return { ...record, deliveries: record.deliveries.filter(({ slot }) => (from === null || slot >= from) && slot <= to) };
}
