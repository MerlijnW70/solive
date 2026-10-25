import type { Address } from "@solana/kit";
import type { Intent } from "@intent-engine/core";
import type { Chain } from "./solver.js";

export type IntentListing = { intents: { address: Address; intent: Intent }[]; unreadable: { address: Address; reason: string }[] };

export async function listingOf(chain: Chain): Promise<IntentListing> {
  return chain.listing === undefined ? { intents: await chain.intents(), unreadable: [] } : chain.listing();
}
