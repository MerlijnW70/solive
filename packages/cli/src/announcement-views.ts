import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { SealRecipient } from "@intent-engine/core";
import {
  type AnnouncementList,
  type AnnouncementView,
  boundMembers,
  type DeliveryOpeners,
  type FirstOpening,
  FirstOpeningRefused,
  heldKeys,
  openingOf,
  type SkippedAnnouncement,
  type Transport,
} from "@intent-engine/client";

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const ANNOUNCE_FIRST =
  "share neither the url nor the work until this announcement lands: the first announcement that opens to the work is paid, so anyone who gets the work first could announce it first";

export const walletOf = (recipient: SealRecipient): Address => (typeof recipient === "string" ? recipient : recipient.wallet);

export const sealedToText = (recipients: readonly SealRecipient[]): string =>
  recipients
    .map((recipient) => (typeof recipient === "string" ? `${recipient} (the key derived from its wallet)` : `${recipient.wallet} (the encryption key its profile publishes)`))
    .join(", ");

export type AnnouncementLine = {
  announcement: Address;
  seq: bigint;
  worker: Address;
  state: AnnouncementView["state"];
  commitment: string;
  slot: bigint;
  announced_at: bigint;
  paid_at?: bigint;
};

export const announcementLine = (a: AnnouncementView): AnnouncementLine => ({
  announcement: a.address,
  seq: a.seq,
  worker: a.worker,
  state: a.state,
  commitment: hex(a.commitment),
  slot: a.slot,
  announced_at: a.announcedAt,
  ...(a.state === "paid" ? { paid_at: a.paidAt } : {}),
});

export type ListView = { complete: boolean; closed: boolean; next_seq: bigint; missing: bigint[]; announcements: AnnouncementLine[] };

export const listView = (list: AnnouncementList): ListView => ({
  complete: list.complete,
  closed: list.closed,
  next_seq: list.nextSeq,
  missing: list.missing,
  announcements: list.announcements.map(announcementLine),
});

export type SkippedLine = { announcement: Address; seq: bigint; worker: Address; reason: SkippedAnnouncement["reason"] };

export const skippedLines = (opening: FirstOpening): SkippedLine[] =>
  opening.skipped.map(({ announcement, seq, worker, reason }) => ({ announcement, seq, worker, reason }));

export type Opened = { announcement: AnnouncementView; salt: string; url: string | null };

export async function openedBy(announcements: readonly AnnouncementView[], openers: DeliveryOpeners): Promise<Opened[]> {
  const held = await heldKeys(openers);
  const opened: Opened[] = [];
  for (const announcement of announcements) {
    const found = await openingOf(announcement, held);
    if (found !== null) {
      opened.push({ announcement, salt: hex(found.salt), url: found.url });
    }
  }
  return opened;
}

export type RefusalHints = { key: string; wait: string; closed?: string };

export const NOBODY_ANNOUNCED = "no worker has announced work to this escrow yet, so it has no delivery book; its worker announces the work first with deliver";

export function refusalNext(refusal: FirstOpeningRefused, hints: RefusalHints): string {
  switch (refusal.reason) {
    case "incomplete":
      return refusal.closed ? (hints.closed ?? "the escrow is no longer open, so nothing can be paid from it") : hints.wait;
    case "key-not-given":
      return hints.key;
    case "claim-held":
      return `wait until the claim of ${refusal.holder ?? "its holder"} ends, or pay the holder once it announces the work`;
    case "nothing-opens":
      return "no announcement opens to this work; its worker announces it first with deliver";
  }
}

export const refusalOf = (error: unknown): FirstOpeningRefused | null => (error instanceof FirstOpeningRefused ? error : null);

export type Captured = { instructions: Instruction[]; payer: TransactionSigner };

export const CAPTURED_SIGNATURE = "1111111111111111111111111111111111111111111111111111111111111111";

export function capturing(transport: Transport): { transport: Transport; sends: Captured[] } {
  const sends: Captured[] = [];
  return {
    sends,
    transport: {
      ...boundMembers(transport),
      send: async (instructions, payer) => {
        sends.push({ instructions: [...instructions], payer });
        return CAPTURED_SIGNATURE;
      },
    },
  };
}
