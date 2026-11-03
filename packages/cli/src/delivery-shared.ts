import type { Address } from "@solana/kit";
import { type DeliveryKey, formatAmount } from "@intent-engine/core";
import { readEncryptionKeyFile } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { loadConfig } from "@intent-engine/client/internal";
import { expandHome } from "./wallet.js";

const SOL_DECIMALS = 9;

export const ALREADY_ANNOUNCED = "this work is already announced to this escrow with this url; nothing was sent";

export const NOTHING_HELD = "no split share is held for this wallet; a release holds a co-author's share only when its token account cannot take it";

export const SIGNATURE_FORMAT = "give the signature as 128 hex digits";

export const signatureBytes = (text: string): Uint8Array | undefined => (/^[0-9a-fA-F]{128}$/.test(text) ? Uint8Array.from(Buffer.from(text, "hex")) : undefined);

export type AnnounceFee = { lamports: bigint; to: Address } | null;

export async function announceFeeOf(transport: Transport): Promise<AnnounceFee> {
  const { config } = await loadConfig(transport);
  const lamports = BigInt(config.announceFee);
  return lamports > 0n ? { lamports, to: config.feeRecipient } : null;
}

export const announceFeePaid = (fee: AnnounceFee): string => (fee === null ? "" : `, plus the announce fee of ${formatAmount(fee.lamports, SOL_DECIMALS)} SOL to the fee recipient ${fee.to}`);

export const announceFeeKept = (fee: AnnounceFee): string => (fee === null ? "" : " and the announce fee does not");

export async function encryptionKeyFile(read: (path: string) => Promise<string>, home: string, path: string, unread?: (error: unknown) => Error): Promise<DeliveryKey> {
  let text: string;
  try {
    text = await read(expandHome(path, home));
  } catch (error) {
    throw unread === undefined ? error : unread(error);
  }
  return readEncryptionKeyFile(text);
}
