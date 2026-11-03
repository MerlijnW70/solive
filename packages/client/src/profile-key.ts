import type { Address } from "@solana/kit";
import { AccountVersionError } from "@intent-engine/core";
import { isEncryptionKeyText, parseEncryptionKey } from "@intent-engine/core/internal";
import { loadProfile } from "./client-claims.js";
import type { Transport } from "./transport.js";

export type ProfileKey =
  | { state: "published"; key: Uint8Array<ArrayBuffer> }
  | { state: "none" }
  | { state: "outdated"; error: AccountVersionError }
  | { state: "invalid"; text: string };

export async function profileKeyOf(transport: Transport, wallet: Address): Promise<ProfileKey> {
  let text: string | null;
  try {
    text = (await loadProfile(transport, wallet))?.encryptionKey ?? null;
  } catch (error) {
    if (error instanceof AccountVersionError) {
      return { state: "outdated", error };
    }
    throw error;
  }
  if (text === null) {
    return { state: "none" };
  }
  return isEncryptionKeyText(text) ? { state: "published", key: parseEncryptionKey(text) } : { state: "invalid", text };
}

export const usableKey = (found: ProfileKey): Uint8Array<ArrayBuffer> | null => (found.state === "published" ? found.key : null);
