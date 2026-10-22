import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { Transport } from "@intent-engine/client";
import { h, transport } from "./harness.js";

export const listing: Transport = {
  ...transport,
  engineAccounts: async () =>
    h.svm.getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS).map((account) => ({
      address: account.address,
      data: new Uint8Array(account.data),
      lamports: account.lamports,
    })),
};

export function listAccounts(): void {
  h.through = listing;
}
