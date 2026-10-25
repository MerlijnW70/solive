import { type Address, getBase58Encoder } from "@solana/kit";
import { AccountVersionError, type DeliveryKey, type DeliveryOpener } from "@intent-engine/core";
import {
  announcementCommitment,
  CLAIM_BOARD_DISCRIMINATOR,
  claimBoardAddress,
  CLAIMS_OPEN,
  claimSlot,
  decodeClaimBoardAccount,
  delivery,
  deliveryKeyOf,
  keyFingerprintV4,
  openDeliveryV4,
  type OpenedDelivery,
  x25519PublicOf,
} from "@intent-engine/core/internal";
import { chainTime, engineAccount } from "./accounts.js";
import { FirstOpeningRefused, type Refusal, type SealedSlot } from "./announce-errors.js";
import { committeeKeys } from "./announce-keys.js";
import { sha256Bytes } from "./announce.js";
import { type AnnouncementList, type AnnouncementView, announcementsOf } from "./announcement-reads.js";
import { loadProfile } from "./client-claims.js";
import { NotSettleable } from "./client-errors.js";
import { intentAddress, type IntentRef } from "./intent-ref.js";
import { hex, type Proof, proofAt } from "./job-proofs.js";
import type { Transport } from "./transport.js";

export type DeliveryOpeners = DeliveryOpener | readonly DeliveryOpener[];

export type FirstOpeningInput = { intent: IntentRef; sha256: string; keypair?: DeliveryOpeners | undefined };

export type FirstOpening = {
  intent: Address;
  announcement: Address;
  seq: bigint;
  worker: Address;
  salt: string;
  url: string | null;
  sha256: string;
  commitment: string;
  skipped: SkippedAnnouncement[];
};

export type SkipReason = "does-not-open" | "forged-wallet-slot" | "wrong-recipient-count";

export type SkippedAnnouncement = { announcement: Address; seq: bigint; worker: Address; reason: SkipReason };

export type Held = { key: DeliveryKey; fingerprint: Uint8Array };

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

export function openersOf(keys: DeliveryOpeners | undefined): readonly DeliveryOpener[] {
  if (keys === undefined) {
    return [];
  }
  return keys instanceof Uint8Array || !Array.isArray(keys) ? [keys as DeliveryOpener] : (keys as readonly DeliveryOpener[]);
}

export async function heldKeys(openers: DeliveryOpeners | undefined): Promise<Held[]> {
  const keys = await Promise.all(openersOf(openers).map(deliveryKeyOf));
  return Promise.all(keys.map(async (key) => ({ key, fingerprint: await keyFingerprintV4(key.publicKey) })));
}

export type AnnouncementOpening = { salt: Uint8Array; url: string | null };

export async function openingOf(announcement: AnnouncementView, held: readonly Held[]): Promise<AnnouncementOpening | null> {
  return announcement.state === "paid" ? { salt: announcement.salt, url: null } : openedWith(announcement, held);
}

export async function openedWith(announcement: AnnouncementView, held: readonly Held[]): Promise<OpenedDelivery | null> {
  for (const { key } of held) {
    const opened = await openDeliveryV4(announcement.blob, key, announcement.intent, announcement.worker);
    if (opened !== null) {
      return opened;
    }
  }
  return null;
}

export async function opensTo(announcement: AnnouncementView, delivered: Uint8Array, salt: Uint8Array): Promise<boolean> {
  return equal(await announcementCommitment(announcement.intent, announcement.worker, { delivered, salt }), announcement.commitment);
}

async function currentFingerprint(transport: Transport, wallet: Address): Promise<Uint8Array | null> {
  const profile = await loadProfile(transport, wallet).catch((error: unknown) => {
    if (error instanceof AccountVersionError) {
      return null;
    }
    throw error;
  });
  const text = profile?.encryptionKey ?? null;
  return text === null ? null : keyFingerprintV4(Uint8Array.from(getBase58Encoder().encode(text)));
}

async function slotsOf(transport: Transport, announcement: AnnouncementView, head: delivery.BlobHead, wallets: readonly Address[]): Promise<SealedSlot[]> {
  return Promise.all(
    head.fps.slice(0, head.count).map(async (fp, i) => {
      const wallet = wallets[i] ?? announcement.attestor;
      if (((head.mask >> i) & 1) === 0) {
        return { wallet, kind: "wallet" as const, fingerprint: hex(fp), published: true };
      }
      const current = await currentFingerprint(transport, wallet);
      return { wallet, kind: "profile" as const, fingerprint: hex(fp), published: current !== null && equal(current, fp) };
    }),
  );
}

async function recipientWallets(transport: Transport, attestor: Address): Promise<readonly Address[]> {
  return (await committeeKeys(transport, attestor))?.members ?? [attestor];
}

async function notDelivery(head: delivery.BlobHead, wallets: readonly Address[]): Promise<SkipReason | null> {
  if (head.count !== wallets.length) {
    return "wrong-recipient-count";
  }
  for (const [i, wallet] of wallets.entries()) {
    if (((head.mask >> i) & 1) === 0 && !equal(head.fps[i] ?? new Uint8Array(), await keyFingerprintV4(x25519PublicOf(wallet)))) {
      return "forged-wallet-slot";
    }
  }
  return null;
}

async function claimHolder(transport: Transport, proof: Proof): Promise<Address | null> {
  if (proof.intent.claims !== CLAIMS_OPEN) {
    return null;
  }
  const board = decodeClaimBoardAccount(await engineAccount(transport, await claimBoardAddress(proof.address), CLAIM_BOARD_DISCRIMINATOR, "claim board"));
  const slot = claimSlot(board, await chainTime(transport));
  return slot.state === "held" ? slot.worker : null;
}

export type FirstOpeningOutcome = { list: AnnouncementList; opening: FirstOpening | FirstOpeningRefused };

type Found = { announcement: AnnouncementView; opened: AnnouncementOpening };

type Walk = { skipped: SkippedAnnouncement[]; found: Found | null; refusal: Refusal | null };

const placeOf = (announcement: AnnouncementView) => ({ announcement: announcement.address, seq: announcement.seq, worker: announcement.worker });

async function walk(transport: Transport, list: AnnouncementList, held: readonly Held[], takes: (found: Found) => Promise<boolean>): Promise<Walk> {
  if (!list.complete) {
    return { skipped: [], found: null, refusal: { reason: "incomplete", missing: list.missing, closed: list.closed } };
  }
  const skipped: SkippedAnnouncement[] = [];
  const recipients = new Map<Address, Promise<readonly Address[]>>();
  const walletsOf = (attestor: Address): Promise<readonly Address[]> => {
    const known = recipients.get(attestor) ?? recipientWallets(transport, attestor);
    recipients.set(attestor, known);
    return known;
  };
  for (const announcement of list.announcements) {
    const head = announcement.state === "paid" ? null : delivery.blobHead(announcement.blob);
    const wallets = head === null ? [] : await walletsOf(announcement.attestor);
    const unfit = head === null ? null : await notDelivery(head, wallets);
    if (unfit !== null) {
      skipped.push({ ...placeOf(announcement), reason: unfit });
      continue;
    }
    const opened = await openingOf(announcement, held);
    if (opened !== null) {
      if (await takes({ announcement, opened })) {
        return { skipped, found: { announcement, opened }, refusal: null };
      }
      continue;
    }
    if (head === null) {
      continue;
    }
    const sealed = head.fps.slice(0, head.count);
    if (held.some(({ fingerprint }) => sealed.some((fp) => equal(fp, fingerprint)))) {
      skipped.push({ ...placeOf(announcement), reason: "does-not-open" });
      continue;
    }
    return { skipped, found: null, refusal: { reason: "key-not-given", ...placeOf(announcement), sealedTo: await slotsOf(transport, announcement, head, wallets) } };
  }
  return { skipped, found: null, refusal: null };
}

async function proofOrRefused(transport: Transport, intent: Address): Promise<Proof> {
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    throw new NotSettleable(intent, "not-a-proof-escrow", "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  return proof;
}

export async function firstOpeningIn(transport: Transport, input: FirstOpeningInput): Promise<FirstOpeningOutcome> {
  const intent = await intentAddress(input.intent);
  const delivered = sha256Bytes(input.sha256);
  const sha256 = hex(delivered);
  const proof = await proofOrRefused(transport, intent);
  const list = await announcementsOf(transport, intent);
  const refused = (refusal: Refusal): FirstOpeningOutcome => ({ list, opening: new FirstOpeningRefused(intent, sha256, refusal) });
  const { skipped, found, refusal } = await walk(transport, list, await heldKeys(input.keypair), ({ announcement, opened }) => opensTo(announcement, delivered, opened.salt));
  if (refusal !== null) {
    return refused(refusal);
  }
  if (found === null) {
    return refused({ reason: "nothing-opens" });
  }
  const { announcement, opened } = found;
  const holder = await claimHolder(transport, proof);
  if (holder !== null && holder !== announcement.worker) {
    return refused({ reason: "claim-held", ...placeOf(announcement), holder });
  }
  return { list, opening: { intent, ...placeOf(announcement), salt: hex(opened.salt), url: opened.url, sha256, commitment: hex(announcement.commitment), skipped } };
}

export async function firstOpening(transport: Transport, input: FirstOpeningInput): Promise<FirstOpening> {
  const { opening } = await firstOpeningIn(transport, input);
  if (opening instanceof FirstOpeningRefused) {
    throw opening;
  }
  return opening;
}

export type OpeningsInput = { intent: IntentRef; keypair?: DeliveryOpeners | undefined };

export type Opening = { announcement: Address; seq: bigint; worker: Address; salt: string; url: string | null };

export type Openings = { intent: Address; opening: Opening | null; skipped: SkippedAnnouncement[] };

export async function openings(transport: Transport, input: OpeningsInput): Promise<Openings> {
  const intent = await intentAddress(input.intent);
  await proofOrRefused(transport, intent);
  const list = await announcementsOf(transport, intent);
  const { skipped, found, refusal } = await walk(transport, list, await heldKeys(input.keypair), async () => true);
  if (refusal !== null) {
    throw new FirstOpeningRefused(intent, null, refusal);
  }
  return { intent, opening: found === null ? null : { ...placeOf(found.announcement), salt: hex(found.opened.salt), url: found.opened.url }, skipped };
}
