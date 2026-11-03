import type { Address } from "@solana/kit";
import { loadCommittee } from "./client-committee.js";
import { profileKeyOf, usableKey } from "./profile-key.js";
import type { Transport } from "./transport.js";

export type KeyedRecipient = { wallet: Address; encryptionKey: Uint8Array | null };

export async function recipientOf(transport: Transport, wallet: Address): Promise<KeyedRecipient> {
  return { wallet, encryptionKey: usableKey(await profileKeyOf(transport, wallet)) };
}

export async function sealRecipients(transport: Transport, wallets: readonly Address[]): Promise<KeyedRecipient[]> {
  const expanded: Address[] = [];
  for (const wallet of wallets) {
    expanded.push(...((await loadCommittee(transport, wallet))?.members ?? [wallet]));
  }
  return Promise.all([...new Set(expanded)].map((wallet) => recipientOf(transport, wallet)));
}
