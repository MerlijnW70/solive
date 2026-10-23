import type { Address } from "@solana/kit";
import {
  type AttestedResultParams,
  checkAccountVersion,
  CLAIMS_OPEN,
  decodeEvent,
  decodeParams,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  type Intent,
  IntentStatus,
  Kind,
  remainingOf,
} from "@intent-engine/core";
import { chainTime, createdAccount } from "./accounts.js";
import { loadClaimsOf } from "./client-claims.js";
import { scan } from "./job-scan.js";
import type { EngineTransaction, Transport } from "./transport.js";

export const JOBS_LIMIT = 50;

export type Proof = { address: Address; intent: Intent; params: AttestedResultParams };

export type JobFilter = {
  attestor?: Address | undefined;
  mint?: Address | undefined;
  minSells?: bigint | undefined;
  unclaimed?: boolean | undefined;
  owner?: Address | undefined;
  excludeOwners?: readonly Address[] | undefined;
};

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function proofOf(address: Address, intent: Intent): Proof | null {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  return params.kind === Kind.AttestedResult && params.specHash.some((b) => b !== 0) ? { address, intent, params } : null;
}

export async function intentAt(transport: Transport, address: Address): Promise<Intent | null> {
  const view = await createdAccount(transport, address);
  const tag = getIntentDiscriminatorBytes();
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)) {
    return null;
  }
  return getIntentDecoder().decode(checkAccountVersion(view.data));
}

export async function proofAt(transport: Transport, address: Address): Promise<Proof | null> {
  const intent = await intentAt(transport, address);
  return intent === null ? null : proofOf(address, intent);
}

export async function createdAtOf(transport: Transport, address: Address): Promise<bigint | null> {
  return (await intentAt(transport, address))?.createdAt ?? null;
}

export async function openProofEscrows(transport: Transport, filter?: Address | JobFilter, limit: number = JOBS_LIMIT): Promise<Proof[]> {
  const { attestor, mint, minSells, unclaimed, owner, excludeOwners = [] }: JobFilter = typeof filter === "string" ? { attestor: filter } : (filter ?? {});
  const [accounts, now] = await Promise.all([transport.intents(), chainTime(transport)]);
  const open = accounts
    .map(({ address, data }) => proofOf(address, getIntentDecoder().decode(data)))
    .filter(
      (proof): proof is Proof =>
        proof !== null &&
        proof.intent.status === IntentStatus.Open &&
        proof.intent.expiresAt > now &&
        (attestor === undefined || proof.params.attestor === attestor) &&
        (mint === undefined || proof.intent.inputMint === mint) &&
        (owner === undefined || proof.intent.owner === owner) &&
        !excludeOwners.includes(proof.intent.owner) &&
        (minSells === undefined || remainingOf(proof.intent) >= minSells),
    )
    .sort((a, b) => (a.intent.expiresAt === b.intent.expiresAt ? 0 : a.intent.expiresAt > b.intent.expiresAt ? -1 : 1));
  return (unclaimed === true ? await unclaimedOnly(transport, open) : open).slice(0, limit);
}

async function unclaimedOnly(transport: Transport, proofs: Proof[]): Promise<Proof[]> {
  const claimable = proofs.filter(({ intent }) => intent.claims === CLAIMS_OPEN);
  const claims = await loadClaimsOf(transport, claimable.map(({ address }) => address));
  const held = new Set(claimable.filter((_, i) => claims[i]?.state === "held" || (claims[i]?.line.waiting ?? 0) > 0).map(({ address }) => address));
  return proofs.filter(({ address }) => !held.has(address));
}

export const createdIn = (emitted: readonly Uint8Array[], intent: Address): boolean =>
  emitted.some((data) => {
    const event = decodeEvent(data);
    return event?.name === "IntentCreated" && "intent" in event.fields && event.fields.intent === intent;
  });

export async function creationSlotOf(transport: Transport, intent: Address, createdAt?: bigint): Promise<bigint | null> {
  const floor = createdAt ?? (await createdAtOf(transport, intent));
  const created = (transaction: EngineTransaction) => !transaction.failed && createdIn(transaction.emitted, intent);
  const { transactions } = await scan(transport, intent, { floor, until: created });
  return transactions.find(created)?.slot ?? null;
}

export async function historyCovers(transport: Transport, intent: Address, createdAt?: bigint): Promise<boolean> {
  const { firstAvailableSlot } = transport;
  if (firstAvailableSlot === undefined) {
    return false;
  }
  const slot = await creationSlotOf(transport, intent, createdAt);
  return slot !== null && (await firstAvailableSlot.call(transport)) <= slot;
}
