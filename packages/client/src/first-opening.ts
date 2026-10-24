import { type Address, getBase58Encoder } from "@solana/kit";
import {
  AccountVersionError,
  announcementCommitment,
  CLAIMS_OPEN,
  claimBoardAddress,
  CLAIM_BOARD_DISCRIMINATOR,
  claimSlot,
  delivery,
  type DeliveryKey,
  deliveryKeyOf,
  type DeliveryOpener,
  getClaimBoardDecoder,
  keyFingerprintV4,
  openDeliveryV4,
  type OpenedDelivery,
} from "@intent-engine/core";
import { chainTime, engineAccount } from "./accounts.js";
import { FirstOpeningRefused, type Refusal, type SealedSlot } from "./announce-errors.js";
import { committeeKeys } from "./announce-keys.js";
import { sha256Bytes } from "./announce.js";
import { type AnnouncementList, type AnnouncementView, announcementsOf } from "./announcement-reads.js";
import { loadProfile } from "./client-claims.js";
import { NotSettleable } from "./client-errors.js";
import { hex, type Proof, proofAt } from "./job-proofs.js";
import type { Transport } from "./transport.js";

export type DeliveryOpeners = DeliveryOpener | readonly DeliveryOpener[];

export type FirstOpeningInput = { intent: Address; sha256: string; keypair?: DeliveryOpeners | undefined };

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

export type SkipReason = "does-not-open";

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
  return announcement.state === "paid" ? { salt: announcement.salt, url: null } : openedBy(announcement, held);
}

async function openedBy(announcement: AnnouncementView, held: readonly Held[]): Promise<OpenedDelivery | null> {
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

async function slotsOf(transport: Transport, announcement: AnnouncementView, head: delivery.BlobHead): Promise<SealedSlot[]> {
  const wallets = (await committeeKeys(transport, announcement.attestor))?.members ?? [announcement.attestor];
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

async function claimHolder(transport: Transport, proof: Proof): Promise<Address | null> {
  if (proof.intent.claims !== CLAIMS_OPEN) {
    return null;
  }
  const board = getClaimBoardDecoder().decode(await engineAccount(transport, await claimBoardAddress(proof.address), CLAIM_BOARD_DISCRIMINATOR, "claim board"));
  const slot = claimSlot(board, await chainTime(transport));
  return slot.state === "held" ? slot.worker : null;
}

export type FirstOpeningOutcome = { list: AnnouncementList; opening: FirstOpening | FirstOpeningRefused };

export async function firstOpeningIn(transport: Transport, input: FirstOpeningInput): Promise<FirstOpeningOutcome> {
  const { intent } = input;
  const delivered = sha256Bytes(input.sha256);
  const sha256 = hex(delivered);
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    throw new NotSettleable(intent, "not-a-proof-escrow", "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  const list = await announcementsOf(transport, intent);
  const refused = (refusal: Refusal): FirstOpeningOutcome => ({ list, opening: new FirstOpeningRefused(intent, sha256, refusal) });
  if (!list.complete) {
    return refused({ reason: "incomplete", missing: list.missing, closed: list.closed });
  }
  const held = await heldKeys(input.keypair);
  const skipped: SkippedAnnouncement[] = [];
  for (const announcement of list.announcements) {
    const at = { announcement: announcement.address, seq: announcement.seq, worker: announcement.worker };
    const opened = await openingOf(announcement, held);
    if (opened !== null) {
      if (await opensTo(announcement, delivered, opened.salt)) {
        const holder = await claimHolder(transport, proof);
        if (holder !== null && holder !== announcement.worker) {
          return refused({ reason: "claim-held", ...at, holder });
        }
        return { list, opening: { intent, ...at, salt: hex(opened.salt), url: opened.url, sha256, commitment: hex(announcement.commitment), skipped } };
      }
      continue;
    }
    const head = delivery.blobHead(announcement.blob);
    const sealed = head.fps.slice(0, head.count);
    if (held.some(({ fingerprint }) => sealed.some((fp) => equal(fp, fingerprint)))) {
      skipped.push({ ...at, reason: "does-not-open" });
      continue;
    }
    return refused({ reason: "key-not-given", ...at, sealedTo: await slotsOf(transport, announcement, head) });
  }
  return refused({ reason: "nothing-opens" });
}

export async function firstOpening(transport: Transport, input: FirstOpeningInput): Promise<FirstOpening> {
  const { opening } = await firstOpeningIn(transport, input);
  if (opening instanceof FirstOpeningRefused) {
    throw opening;
  }
  return opening;
}
