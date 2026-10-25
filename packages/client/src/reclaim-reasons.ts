import type { Address } from "@solana/kit";
import { delivery, refutationAddress } from "@intent-engine/core/internal";
import { type AnnouncementView, announcementsIn } from "./announcement-reads.js";
import type { Transport } from "./transport.js";

export type KeptAnnouncement = { announcement: Address; reason: string };

const dateOf = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

const paidAlone = (paid: AnnouncementView): boolean => paid.splitHash.every((b) => b === 0);

const mayRefute = (earlier: AnnouncementView, paid: AnnouncementView): boolean => earlier.seq < paid.seq && !(paidAlone(paid) && paid.worker === earlier.worker);

async function refutersIn(transport: Transport, intent: Address, mine: readonly AnnouncementView[], now: bigint): Promise<KeptAnnouncement[]> {
  const { announcements, unreadable } = await announcementsIn(transport, intent);
  const paid = announcements.find(({ state }) => state === "paid");
  if (paid === undefined) {
    const reason = `not every announcement of escrow ${intent} could be read, so a paid one it could refute is not ruled out`;
    return unreadable.length === 0 ? [] : mine.map(({ address }) => ({ announcement: address, reason }));
  }
  const until = paid.paidAt + delivery.REFUTE_WINDOW_SECS;
  const earlier = now < until ? mine.filter((announcement) => mayRefute(announcement, paid)) : [];
  if (earlier.length === 0) {
    return [];
  }
  const refutations = await transport.getAccounts(await Promise.all(earlier.map(({ address }) => refutationAddress(address))));
  return earlier
    .filter((_, i) => refutations[i] === null || refutations[i] === undefined)
    .map(({ address }) => ({
      announcement: address,
      reason: `it is earlier than ${paid.address}, which escrow ${intent} paid, so it can refute that release until ${dateOf(until)}`,
    }));
}

export async function refutersKept(transport: Transport, closable: readonly AnnouncementView[], now: bigint): Promise<KeptAnnouncement[]> {
  const announced = closable.filter(({ state }) => state === "announced");
  const intents = [...new Set(announced.map(({ intent }) => intent))];
  const kept = await Promise.all(intents.map((intent) => refutersIn(transport, intent, announced.filter((a) => a.intent === intent), now)));
  return kept.flat();
}

export function keptReason(announcement: AnnouncementView): string {
  return announcement.state === "paid"
    ? `it was paid, and the program keeps it for the refutation window until ${dateOf(announcement.paidAt + delivery.REFUTE_WINDOW_SECS)}`
    : `its escrow ${announcement.intent} is still open`;
}
