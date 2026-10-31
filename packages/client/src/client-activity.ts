import type { Address, Signature } from "@solana/kit";
import { decodeEvent, type EngineEvent, INTENT_ENGINE_PROGRAM_ADDRESS, InvalidInput, Kind, SdkError } from "@intent-engine/core";
import {
  CREATE_INTENT_BY_AGENT_DISCRIMINATOR,
  CREATE_INTENT_DISCRIMINATOR,
  CREATE_INTENT_SIGNED_DISCRIMINATOR,
  decodeParams,
  getCreateIntentByAgentInstructionDataDecoder,
  getCreateIntentInstructionDataDecoder,
  getCreateIntentSignedInstructionDataDecoder,
} from "@intent-engine/core/internal";
import { TransportLacks } from "./client-errors.js";
import { engineCalls } from "./job-origins.js";
import { isTransactionSignature } from "./signatures.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type ActivityEvent = EngineEvent & { signature: Signature; slot: bigint; blockTime: bigint | null };

export type ActivityOptions = { until?: string; before?: string; limit?: number };

export type ActivityPage = { events: ActivityEvent[]; newest: string | null; next: string | null; complete: boolean; unread: Signature[] };

export class TransactionUnread extends SdkError {
  readonly code = "transaction-unread";
  override readonly name = "TransactionUnread";
  readonly signature: string;

  constructor(signature: string) {
    super(`the node did not serve transaction ${signature}, so what it created is unknown; read it again later`);
    this.signature = signature;
  }
}

export type EscrowTerms = {
  intent: Address;
  signature: Signature;
  owner: Address;
  attestor: Address;
  specHash: string;
  mint: Address;
  amountIn: bigint;
  escrowed: bigint;
  judgeFee: bigint;
  minResult: bigint;
  maxResult: bigint;
  nonce: bigint;
  expiresAt: bigint;
};

export const ACTIVITY_LIMIT = 100;
export const ACTIVITY_LIMIT_MAX = 1_000;
export const ACTIVITY_BATCH = 100;
export const ACTIVITY_LIMIT_RANGE = `limit must be a whole number from 1 to ${ACTIVITY_LIMIT_MAX}`;

type CreateArgs = { nonce: bigint; kind: number; params: Uint8Array };

type CreateCall = { tag: Uint8Array; intentAt: number; decode: (data: Uint8Array) => CreateArgs };

const argsOf = ({ args }: { args: { nonce: bigint; kind: number; params: ArrayLike<number> } }): CreateArgs => ({
  nonce: args.nonce,
  kind: args.kind,
  params: Uint8Array.from(args.params),
});

const CREATE_CALLS: readonly CreateCall[] = [
  { tag: Uint8Array.from(CREATE_INTENT_DISCRIMINATOR), intentAt: 3, decode: (data) => argsOf(getCreateIntentInstructionDataDecoder().decode(data)) },
  { tag: Uint8Array.from(CREATE_INTENT_BY_AGENT_DISCRIMINATOR), intentAt: 5, decode: (data) => argsOf(getCreateIntentByAgentInstructionDataDecoder().decode(data)) },
  { tag: Uint8Array.from(CREATE_INTENT_SIGNED_DISCRIMINATOR), intentAt: 4, decode: (data) => argsOf(getCreateIntentSignedInstructionDataDecoder().decode(data)) },
];

const tagged = (data: Uint8Array, tag: Uint8Array): boolean => data.length >= tag.length && tag.every((b, i) => data[i] === b);

const hex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const eventsIn = (transaction: EngineTransaction): EngineEvent[] =>
  transaction.emitted.map(decodeEvent).filter((event): event is EngineEvent => event !== null);

function createArgs(call: CreateCall, data: Uint8Array): CreateArgs | null {
  try {
    return call.decode(data);
  } catch {
    return null;
  }
}

export function escrowTermsIn(transaction: EngineTransaction, intent: Address): EscrowTerms | null {
  if (transaction.unread === true) {
    throw new TransactionUnread(transaction.signature);
  }
  if (transaction.failed) {
    return null;
  }
  const created = eventsIn(transaction).find((event) => event.name === "IntentCreated" && event.fields.intent === intent);
  if (created?.name !== "IntentCreated" || created.fields.kind !== Kind.AttestedResult) {
    return null;
  }
  const { owner, nonce, inputMint, escrowed, expiresAt } = created.fields;
  for (const { data, accounts } of engineCalls(transaction)) {
    const call = CREATE_CALLS.find(({ tag }) => tagged(data, tag));
    const args = call === undefined || accounts?.[call.intentAt] !== intent ? null : createArgs(call, data);
    if (args === null || args.nonce !== nonce || args.kind !== Kind.AttestedResult) {
      continue;
    }
    let params: ReturnType<typeof decodeParams>;
    try {
      params = decodeParams(args.kind, args.params);
    } catch {
      continue;
    }
    if (params.kind !== Kind.AttestedResult) {
      continue;
    }
    const { attestor, specHash, amountIn, judgeFee, minResult, maxResult } = params;
    return { intent, signature: transaction.signature, owner, attestor, specHash: hex(specHash), mint: inputMint, amountIn, escrowed, judgeFee, minResult, maxResult, nonce, expiresAt };
  }
  return null;
}

export async function escrowTermsOf(transport: Transport, transaction: EngineTransaction | string, intent: Address): Promise<EscrowTerms | null> {
  if (typeof transaction !== "string") {
    return escrowTermsIn(transaction, intent);
  }
  if (transport.transactionOf === undefined) {
    throw new TransportLacks("transactionOf");
  }
  const found = await transport.transactionOf(transaction);
  if (found === null) {
    throw new TransactionUnread(transaction);
  }
  return escrowTermsIn(found, intent);
}

function checkedCursor(field: "until" | "before", value: string | undefined): void {
  if (value !== undefined && !isTransactionSignature(value)) {
    throw new InvalidInput(field, "format", `${field} must be a transaction signature`);
  }
}

const activityIn = (transactions: readonly EngineTransaction[]): ActivityEvent[] =>
  transactions
    .filter(({ failed }) => !failed)
    .flatMap((transaction) => {
      const { signature, slot, blockTime } = transaction;
      return eventsIn(transaction)
        .reverse()
        .map((event) => ({ ...event, signature, slot, blockTime }));
    });

export async function activityOf(transport: Transport, options: ActivityOptions = {}): Promise<ActivityPage> {
  const limit = options.limit ?? ACTIVITY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_LIMIT_MAX) {
    throw new InvalidInput("limit", "range", ACTIVITY_LIMIT_RANGE);
  }
  checkedCursor("until", options.until);
  checkedCursor("before", options.before);
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    throw new TransportLacks(signaturesOf === undefined ? "signaturesOf" : "transactionsOf");
  }
  const events: ActivityEvent[] = [];
  const unread: Signature[] = [];
  let newest: string | null = null;
  let before = options.before;
  let read = 0;
  const page = (next: string | null): ActivityPage => ({ events, newest: unread.length === 0 ? newest : null, next, complete: unread.length === 0, unread });
  while (read < limit) {
    const asked = Math.min(ACTIVITY_BATCH, limit - read);
    const listed = await signaturesOf.call(transport, INTENT_ENGINE_PROGRAM_ADDRESS, asked, before, options.until);
    const oldest = listed.at(-1);
    if (oldest === undefined) {
      return page(null);
    }
    newest ??= listed[0]?.signature ?? null;
    read += listed.length;
    const landed = listed.filter(({ failed }) => !failed);
    const transactions = landed.length === 0 ? [] : await transactionsOf.call(transport, landed);
    unread.push(...transactions.filter((transaction) => transaction.unread === true).map(({ signature }) => signature));
    events.push(...activityIn(transactions));
    before = oldest.signature;
    if (listed.length < asked) {
      return page(null);
    }
  }
  return page(before ?? null);
}
