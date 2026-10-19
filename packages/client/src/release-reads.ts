import type { Address } from "@solana/kit";
import {
  decodeEvent,
  type EngineEvent,
  FILL_ATTESTED_SPLIT_COMMITTEE_DISCRIMINATOR,
  FILL_ATTESTED_SPLIT_DISCRIMINATOR,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getFillAttestedSplitInstructionDataDecoder,
} from "@intent-engine/core";
import { engineCalls } from "./job-origins.js";
import type { EngineTransaction } from "./transport.js";

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
