import type { ReadonlyUint8Array } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { EngineAccountFilter, Transport } from "@intent-engine/client";
import { h, transport } from "./harness.js";

export function matches(filter: EngineAccountFilter | undefined, data: ReadonlyUint8Array): boolean {
  return (
    filter === undefined ||
    ((filter.dataSize === undefined || data.length === filter.dataSize) &&
      data.length >= filter.discriminator.length &&
      filter.discriminator.every((b, i) => data[i] === b))
  );
}

export const listing: Transport = {
  ...transport,
  engineAccounts: async (filter) =>
    h.svm
      .getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS)
      .filter((account) => matches(filter, account.data))
      .map((account) => ({
        address: account.address,
        data: new Uint8Array(account.data),
        lamports: account.lamports,
      })),
};

export function listAccounts(): void {
  h.through = listing;
}
