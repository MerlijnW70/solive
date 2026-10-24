import type { Address } from "@solana/kit";
import { decodeEvent, type EngineEvent } from "@intent-engine/core";
import { announcementsOf, AnnouncementsUnreadable, type EngineTransaction, reputationOf, type Transport } from "@intent-engine/client";
import { account, amount, choice, flag, list, object, optional } from "../schema.js";

export const MAX_STANDING = 64;

const STANDINGS = ["substantiated", "unsubstantiated", "unverifiable"] as const;

export const refutationItem = object({
  refutation: account(),
  earlier: account("the earlier announcement the refutation reveals"),
  earlier_seq: amount(),
  earlier_worker: account(),
  standing: choice(STANDINGS, "substantiated: the earlier announcement opens, at every slot, to the paid work; only those count against the paid worker"),
});

export const standingOutput = {
  announcement: optional(account("the announcement the release paid")),
  seq: optional(amount("its place among the escrow's announcements")),
  announcer: optional(account("the wallet that made the paid announcement; in a split, the other paid wallets are co-authors")),
  passed_over: optional(
    list(object({ announcement: account(), seq: amount(), worker: account() }), MAX_STANDING, "earlier announcements to the escrow, still on chain, that the release passed over"),
  ),
  refutations: optional(list(refutationItem, MAX_STANDING, "refutations of the paid announcement, with their standing")),
  refuted_by: optional(account("a substantiated refutation: someone announced the same work earlier, so this release counts against the announcer")),
  standing_complete: optional(flag("false when the announcer's record could not be read in full, so refutations may be missing")),
};

export type PaidAnnouncement = { announcement: Address; seq: bigint; worker: Address };

async function passedOver(transport: Transport, intent: Address, paid: PaidAnnouncement) {
  try {
    const list = await announcementsOf(transport, intent);
    return list.announcements.filter(({ seq }) => seq < paid.seq).map(({ address, seq, worker }) => ({ announcement: address, seq, worker }));
  } catch (error) {
    if (error instanceof AnnouncementsUnreadable) {
      return [];
    }
    throw error;
  }
}

export async function releaseStanding(transport: Transport, intent: Address, paid: PaidAnnouncement) {
  const [earlier, reputation] = await Promise.all([passedOver(transport, intent, paid), reputationOf(transport, paid.worker).catch(() => null)]);
  const record = reputation?.records.find(({ announcement }) => announcement === paid.announcement);
  return {
    announcement: paid.announcement,
    seq: paid.seq,
    announcer: paid.worker,
    ...(earlier.length === 0 ? {} : { passed_over: earlier.slice(0, MAX_STANDING) }),
    ...(record === undefined
      ? {}
      : {
          refutations: record.refutations.slice(0, MAX_STANDING).map(({ refutation, earlier: at, earlierSeq, earlierWorker, standing }) => ({
            refutation,
            earlier: at,
            earlier_seq: earlierSeq,
            earlier_worker: earlierWorker,
            standing,
          })),
          ...(record.refutedBy === undefined ? {} : { refuted_by: record.refutedBy }),
        }),
    ...(record === undefined || reputation?.complete !== true ? { standing_complete: false } : {}),
  };
}

export type PaidWork = { announcement: Address; seq: bigint; worker: Address; sha256: string; salt: string };

const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString("hex");

export function deliveryReleased(tx: EngineTransaction, intent: Address): PaidWork | null {
  if (tx.failed) {
    return null;
  }
  for (const data of tx.emitted) {
    const event = decodeEvent(data) as EngineEvent | null;
    if (event?.name === "DeliveryReleased" && event.fields.intent === intent) {
      const { announcement, seq, worker, delivered, salt } = event.fields;
      return { announcement, seq, worker, sha256: hexOf(delivered), salt: hexOf(salt) };
    }
  }
  return null;
}
