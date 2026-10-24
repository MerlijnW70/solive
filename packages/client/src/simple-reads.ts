import type { Address, Signature } from "@solana/kit";
import { isSha256Hex } from "@intent-engine/core";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { refutationsOf } from "./announcement-reads.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { heldKeys, openingOf, opensTo } from "./first-opening.js";
import { standingOf } from "./refutation-standing.js";
import { paidWalletsOf, releasedDelivery, releaseOf } from "./release-reads.js";
import type { SimpleContext } from "./simple-orders.js";
import type { Announcement, DeliveriesInput, ReceiptInput, ReleaseReceipt } from "./simple-types.js";

export function sha256Given(sha256: string, name: string): string {
  const lowered = sha256.trim().toLowerCase();
  if (!isSha256Hex(lowered)) {
    throw new RangeError(`${name} must be 64 hex digits`);
  }
  return lowered;
}

const bytesOf = (sha256: string): Uint8Array => Uint8Array.from(Buffer.from(sha256, "hex"));

export function workReads(ctx: SimpleContext) {
  const { transport } = ctx.client;

  const refutedBy = async (announcement: Address): Promise<{ refutedBy: Address | null; complete: boolean }> => {
    try {
      for (const refutation of await refutationsOf(transport, announcement)) {
        if ((await standingOf(transport, refutation)) === "substantiated") {
          return { refutedBy: refutation.address, complete: true };
        }
      }
      return { refutedBy: null, complete: true };
    } catch (error) {
      if (error instanceof AnnouncementsUnreadable) {
        return { refutedBy: null, complete: false };
      }
      throw error;
    }
  };

  const receipt = async (input: ReceiptInput): Promise<ReleaseReceipt> => {
    const { escrow } = input;
    const transactions = await transport.engineTransactions(HISTORY_LIMIT, escrow);
    const release = releaseOf(transactions, escrow);
    if (release === undefined || (release.event.name !== "IntentAttested" && release.event.name !== "IntentSplit")) {
      return { escrow, released: false, signature: null, payee: null, payees: [], deliveredSha256: null, valid: false, refutedBy: null, complete: true, summary: `Escrow ${escrow} is not released yet` };
    }
    const signature = release.transaction.signature as Signature;
    const payees = (await paidWalletsOf(transport, release, escrow)) ?? [];
    const released = releasedDelivery(release.transaction, escrow);
    const standing = released === null ? { refutedBy: null, complete: true } : await refutedBy(released.announcement);
    const payee = payees[0] ?? null;
    const valid = released !== null;
    const work = released === null ? "no announced work" : `work ${released.sha256}`;
    return {
      escrow,
      released: true,
      signature,
      payee,
      payees,
      deliveredSha256: released?.sha256 ?? null,
      valid,
      refutedBy: standing.refutedBy,
      complete: standing.complete,
      summary: `Escrow ${escrow} was released in ${signature} to ${payees.length === 0 ? "an unknown wallet" : payees.join(", ")} for ${work}; the release is ${valid ? "valid" : "not valid"}`,
    };
  };

  const deliveries = async (input: DeliveriesInput): Promise<Announcement[]> => {
    const given = input.sha256 === undefined ? [] : [sha256Given(input.sha256, "sha256")];
    const [list, released, held] = await Promise.all([ctx.client.announcements(input.escrow), receipt({ escrow: input.escrow }), heldKeys(input.keypair)]);
    const candidates = [...new Set([...given, ...(released.deliveredSha256 === null ? [] : [released.deliveredSha256])])];
    return Promise.all(
      list.announcements.map(async (announcement) => {
        const opening = await openingOf(announcement, held);
        let sha256: string | null = null;
        for (const candidate of opening === null ? [] : candidates) {
          if (sha256 === null && (await opensTo(announcement, bytesOf(candidate), opening?.salt ?? new Uint8Array()))) {
            sha256 = candidate;
          }
        }
        return { worker: announcement.worker, sha256, url: opening?.url ?? null, opened: sha256 !== null, announcement: announcement.address, seq: announcement.seq };
      }),
    );
  };

  return { receipt, deliveries };
}
