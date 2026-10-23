import type { Address } from "@solana/kit";
import { AccountVersionError, isEncryptionKeyText, parseEncryptionKey } from "@intent-engine/core";
import { loadProfile } from "./client-claims.js";
import { loadCommittee } from "./client-committee.js";
import type { Transport } from "./transport.js";

export type KeyedRecipient = { wallet: Address; encryptionKey: Uint8Array | null };

export async function recipientOf(transport: Transport, wallet: Address): Promise<KeyedRecipient> {
  const profile = await loadProfile(transport, wallet).catch((error: unknown) => {
    if (error instanceof AccountVersionError) {
      return null;
    }
    throw error;
  });
  const key = profile?.encryptionKey ?? null;
  return { wallet, encryptionKey: key === null || !isEncryptionKeyText(key) ? null : parseEncryptionKey(key) };
}

export async function sealRecipients(transport: Transport, wallets: readonly Address[]): Promise<KeyedRecipient[]> {
  const expanded: Address[] = [];
  for (const wallet of wallets) {
    expanded.push(...((await loadCommittee(transport, wallet))?.members ?? [wallet]));
  }
  return Promise.all([...new Set(expanded)].map((wallet) => recipientOf(transport, wallet)));
}
