import type { Address } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { decodeParams, readIntentAccounts } from "@intent-engine/core/internal";
import type { IntentQuery } from "../src/index.js";
import { intentMatchesQuery } from "../src/internal.js";

export const FIELDS = ["owner", "status", "kind", "inputMint", "outputMint", "attestor"] as const;

type Entry = { address: Address; data: Uint8Array };

export function donorsOf(entries: readonly Entry[], elsewhere: Address): Required<IntentQuery>[] {
  return readIntentAccounts(entries).intents.map(({ intent }) => {
    const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
    return {
      owner: intent.owner,
      status: intent.status,
      kind: intent.kind,
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      attestor: params.kind === Kind.AttestedResult ? params.attestor : elsewhere,
    };
  });
}

export function queryShapes(donors: readonly Required<IntentQuery>[]): IntentQuery[] {
  const seen = new Map<string, IntentQuery>();
  for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
    for (let start = 0; start < donors.length; start++) {
      for (const mixed of [false, true]) {
        const query: Record<string, unknown> = {};
        FIELDS.forEach((field, at) => {
          if (mask & (1 << at)) {
            const donor = donors[mixed ? (start + at) % donors.length : start];
            query[field] = donor?.[field];
          }
        });
        const asked = query as IntentQuery;
        if (asked.attestor !== undefined && asked.kind !== undefined && asked.kind !== Kind.AttestedResult) {
          continue;
        }
        seen.set(JSON.stringify(query), asked);
      }
    }
  }
  return [...seen.values()];
}

export const fieldCount = (query: IntentQuery): number => Object.keys(query).length;

export function expectedFor(entries: readonly Entry[], query: IntentQuery): Address[] {
  return readIntentAccounts(entries)
    .intents.filter(({ intent }) => intentMatchesQuery(intent, query))
    .map(({ address }) => address);
}
