import type { Address } from "@solana/kit";
import { type SealRecipient } from "@intent-engine/core";
import { announcementCommitment, delivery, keyFingerprintV4, openWithEsk, parseEncryptionKey } from "@intent-engine/core/internal";
import { committeeKeys } from "./announce-keys.js";
import type { RefutationView } from "./announcement-reads.js";
import { loadProfile } from "./client-claims.js";
import type { Transport } from "./transport.js";

export type RefutationStanding = "substantiated" | "unsubstantiated" | "unverifiable";

export type RefutationRecord = { refutation: Address; earlier: Address; earlierSeq: bigint; earlierWorker: Address; standing: RefutationStanding };

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

async function profileKey(transport: Transport, wallet: Address): Promise<Uint8Array | null> {
  try {
    const text = (await loadProfile(transport, wallet))?.encryptionKey ?? null;
    return text === null ? null : parseEncryptionKey(text);
  } catch {
    return null;
  }
}

async function recipientsOf(transport: Transport, refutation: RefutationView, head: delivery.BlobHead): Promise<SealRecipient[] | null> {
  const wallets = (await committeeKeys(transport, refutation.attestor))?.members ?? [refutation.attestor];
  if (wallets.length !== head.count) {
    return null;
  }
  const recipients: SealRecipient[] = [];
  for (const [i, wallet] of wallets.entries()) {
    if (((head.mask >> i) & 1) === 0) {
      recipients.push(wallet);
      continue;
    }
    const key = await profileKey(transport, wallet);
    if (key === null || !equal(await keyFingerprintV4(key), head.fps[i] ?? new Uint8Array())) {
      return null;
    }
    recipients.push({ wallet, encryptionKey: key });
  }
  return recipients;
}

export async function standingOf(transport: Transport, refutation: RefutationView): Promise<RefutationStanding> {
  let head: delivery.BlobHead;
  try {
    head = delivery.blobHead(refutation.blob);
  } catch {
    return "unsubstantiated";
  }
  const recipients = await recipientsOf(transport, refutation, head);
  if (recipients === null) {
    return "unverifiable";
  }
  const opened = await openWithEsk(refutation.blob, refutation.esk, recipients, refutation.intent, refutation.earlierWorker);
  if (opened === null) {
    return "unsubstantiated";
  }
  const commitment = await announcementCommitment(refutation.intent, refutation.earlierWorker, { delivered: refutation.delivered, salt: opened.salt });
  return equal(commitment, refutation.earlierCommitment) ? "substantiated" : "unsubstantiated";
}

export async function refutationRecord(transport: Transport, refutation: RefutationView): Promise<RefutationRecord> {
  return {
    refutation: refutation.address,
    earlier: refutation.earlierAnnouncement,
    earlierSeq: refutation.earlierSeq,
    earlierWorker: refutation.earlierWorker,
    standing: await standingOf(transport, refutation),
  };
}
