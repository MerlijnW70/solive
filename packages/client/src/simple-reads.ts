import type { Address, Signature } from "@solana/kit";
import { IntentStatus, InvalidInput } from "@intent-engine/core";
import { isSha256Hex, type UnreadableAccount } from "@intent-engine/core/internal";
import { AnnouncementsUnreadable } from "./announce-errors.js";
import { refutationsOf } from "./announcement-reads.js";
import { HISTORY_LIMIT } from "./client-types.js";
import { heldKeys, openedWith, opensTo } from "./first-opening.js";
import { standingOf } from "./refutation-standing.js";
import { intentAt } from "./job-proofs.js";
import { intentHistory, paidWalletsOf, type Read, releasedDelivery, releaseOf } from "./release-reads.js";
import type { SimpleContext } from "./simple-orders.js";
import type { Announcement, DeliveriesInput, EscrowOpeningsInput, ReceiptInput, ReleaseReceipt } from "./simple-types.js";
import { hexBytes } from "./encoding.js";
import type { EngineTransaction } from "./transport.js";

export function sha256Given(sha256: string, name: string): string {
  const lowered = sha256.trim().toLowerCase();
  if (!isSha256Hex(lowered)) {
    throw new InvalidInput(name, "format", `${name} must be 64 hex digits`);
  }
  return lowered;
}

type Standing = { refutedBy: Address | null; complete: boolean; unreadable: UnreadableAccount[] };

const bytesOf = (sha256: string): Uint8Array => hexBytes(sha256);

function settledRelease(transactions: readonly EngineTransaction[], escrow: Address): Read | undefined {
  const release = releaseOf(transactions, escrow);
  return release?.event.name === "IntentAttested" || release?.event.name === "IntentSplit" ? release : undefined;
}

export function workReads(ctx: SimpleContext) {
  const { transport } = ctx.client;

  const refutedBy = async (announcement: Address): Promise<Standing> => {
    try {
      const { refutations, unreadable } = await refutationsOf(transport, announcement);
      for (const refutation of refutations) {
        if ((await standingOf(transport, refutation)) === "substantiated") {
          return { refutedBy: refutation.address, complete: unreadable.length === 0, unreadable };
        }
      }
      return { refutedBy: null, complete: unreadable.length === 0, unreadable };
    } catch (error) {
      if (error instanceof AnnouncementsUnreadable) {
        return { refutedBy: null, complete: false, unreadable: [] };
      }
      throw error;
    }
  };

  const receipt = async (input: ReceiptInput): Promise<ReleaseReceipt> => {
    const { escrow } = input;
    const releasedIn = (found: readonly EngineTransaction[]): boolean => settledRelease(found, escrow) !== undefined;
    const [read, held] = await Promise.all([intentHistory(transport, escrow, HISTORY_LIMIT, releasedIn), intentAt(transport, escrow)]);
    const release = settledRelease(read.transactions, escrow);
    if (release === undefined) {
      const unreleased = { escrow, signature: null, payee: null, payees: [], deliveredSha256: null, valid: false, refutedBy: null, unreadable: [] };
      const beyond = `the ${read.transactions.length} most recent transactions of the escrow read before paging stopped at its limit`;
      if (held?.status === IntentStatus.Filled) {
        const where = read.complete ? "none of its transactions holds a release this client reads" : `its release lies beyond ${beyond}`;
        return { ...unreleased, released: true, complete: false, summary: `Escrow ${escrow} is filled on chain, but ${where}, so its payee and work are unknown` };
      }
      if (!read.complete) {
        return { ...unreleased, released: false, complete: false, summary: `Escrow ${escrow} shows no release in ${beyond}, so an older release is not ruled out` };
      }
      return { ...unreleased, released: false, complete: true, summary: `Escrow ${escrow} is not released yet` };
    }
    const signature = release.transaction.signature as Signature;
    const payees = (await paidWalletsOf(transport, release, escrow)) ?? [];
    const released = releasedDelivery(release.transaction, escrow);
    const standing: Standing = released === null ? { refutedBy: null, complete: true, unreadable: [] } : await refutedBy(released.announcement);
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
      unreadable: standing.unreadable,
      summary: `Escrow ${escrow} was released in ${signature} to ${payees.length === 0 ? "an unknown wallet" : payees.join(", ")} for ${work}; the release is ${valid ? "valid" : "not valid"}`,
    };
  };

  const deliveries = async (input: DeliveriesInput): Promise<Announcement[]> => {
    const given = input.sha256 === undefined ? [] : [sha256Given(input.sha256, "sha256")];
    const [list, released, held] = await Promise.all([ctx.client.announcements(input.escrow), receipt({ escrow: input.escrow }), heldKeys(input.keypair)]);
    const candidates = [...new Set([...given, ...(released.deliveredSha256 === null ? [] : [released.deliveredSha256])])];
    return Promise.all(
      list.announcements.map(async (announcement) => {
        const keyed = await openedWith(announcement, held);
        const salt = keyed?.salt ?? (announcement.state === "paid" ? announcement.salt : null);
        let sha256: string | null = null;
        for (const candidate of salt === null ? [] : candidates) {
          if (sha256 === null && (await opensTo(announcement, bytesOf(candidate), salt ?? new Uint8Array()))) {
            sha256 = candidate;
          }
        }
        return { worker: announcement.worker, sha256, url: keyed?.url ?? null, opened: keyed !== null, announcement: announcement.address, seq: announcement.seq };
      }),
    );
  };

  const openings = async (input: EscrowOpeningsInput) => ctx.client.openings({ intent: input.escrow, keypair: input.keypair });

  return { receipt, deliveries, openings };
}
