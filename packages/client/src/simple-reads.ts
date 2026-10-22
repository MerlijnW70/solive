import type { Address, Signature } from "@solana/kit";
import { isSha256Hex } from "@intent-engine/core";
import { HISTORY_LIMIT } from "./client-types.js";
import { paidWalletsOf, publishedSalts, releaseStandingOf } from "./delivery-openings.js";
import { type Delivery, type DeliveryRecord, earlier, opensWith } from "./job-deliveries.js";
import { recordedRelease } from "./job-memos.js";
import { proofAt } from "./job-proofs.js";
import { eventsOf, releaseOf } from "./release-reads.js";
import type { SimpleContext } from "./simple-orders.js";
import type { Announcement, DeliveriesInput, ReceiptInput, ReleaseReceipt } from "./simple-types.js";

export type Opened = Delivery & { salt: string };

export function sha256Given(sha256: string, name: string): string {
  const lowered = sha256.trim().toLowerCase();
  if (!isSha256Hex(lowered)) {
    throw new RangeError(`${name} must be 64 hex digits`);
  }
  return lowered;
}

export function openingSalt(delivery: Delivery, record: DeliveryRecord, sha256: string): string | null {
  const salts = [...(delivery.salt === "" ? [] : [delivery.salt]), ...publishedSalts(delivery, record.openings)];
  return salts.find((salt) => opensWith(delivery, salt, sha256)) ?? null;
}

export function firstOpened(record: DeliveryRecord, sha256: string): Opened | null {
  let first: Opened | null = null;
  for (const delivery of record.deliveries) {
    const salt = openingSalt(delivery, record, sha256);
    if (salt !== null && (first === null || earlier(delivery, first))) {
      first = { ...delivery, sha256, salt };
    }
  }
  return first;
}

export function workReads(ctx: SimpleContext) {
  const { transport } = ctx.client;

  const recordOf = async (escrow: Address, keypair: DeliveriesInput["keypair"]): Promise<DeliveryRecord> => {
    const proof = await proofAt(transport, escrow);
    if (proof === null) {
      return { deliveries: [], openings: [], complete: true, pages: 0 };
    }
    return ctx.client.deliveryRecord({ judge: proof.params.attestor, intent: escrow, ...(keypair === undefined ? {} : { keypair }) });
  };

  const receipt = async (input: ReceiptInput): Promise<ReleaseReceipt> => {
    const { escrow } = input;
    const transactions = await transport.engineTransactions(HISTORY_LIMIT, escrow);
    const release = releaseOf(transactions, escrow);
    if (release === undefined || (release.event.name !== "IntentAttested" && release.event.name !== "IntentSplit")) {
      return { escrow, released: false, signature: null, payee: null, payees: [], deliveredSha256: null, valid: false, refutedBy: null, complete: true, summary: `Escrow ${escrow} is not released yet` };
    }
    const attestor = release.event.fields.attestor;
    const signature = release.transaction.signature as Signature;
    const recorded = recordedRelease(transactions, release.transaction, attestor);
    const payees = (await paidWalletsOf(transport, release, escrow)) ?? [];
    const creation = eventsOf(transactions, escrow).find(({ event }) => event.name === "IntentCreated")?.transaction;
    const standing =
      recorded === null
        ? { valid: false, refutedBy: null, complete: true }
        : await releaseStandingOf(transport, {
            intent: escrow,
            attestor,
            release: release.transaction,
            recorded,
            payees,
            createdAt: creation?.blockTime ?? null,
            from: creation?.slot ?? null,
          });
    const payee = payees[0] ?? null;
    const work = recorded === null ? "no recorded work" : `work ${recorded.sha256}`;
    const verdict = standing.valid ? "valid" : "not valid";
    return {
      escrow,
      released: true,
      signature,
      payee,
      payees,
      deliveredSha256: recorded?.sha256 ?? null,
      valid: standing.valid,
      refutedBy: standing.refutedBy,
      complete: standing.complete,
      summary: `Escrow ${escrow} was released in ${signature} to ${payees.length === 0 ? "an unknown wallet" : payees.join(", ")} for ${work}; the release is ${verdict}`,
    };
  };

  const deliveries = async (input: DeliveriesInput): Promise<Announcement[]> => {
    const given = input.sha256 === undefined ? [] : [sha256Given(input.sha256, "sha256")];
    const [record, released] = await Promise.all([recordOf(input.escrow, input.keypair), receipt({ escrow: input.escrow })]);
    const candidates = [...new Set([...given, ...(released.deliveredSha256 === null ? [] : [released.deliveredSha256])])];
    return [...record.deliveries]
      .sort((a, b) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0))
      .map((delivery) => {
        const sha256 = candidates.find((candidate) => openingSalt(delivery, record, candidate) !== null) ?? null;
        return {
          worker: delivery.worker,
          sha256,
          url: delivery.url === "" ? null : delivery.url,
          opened: sha256 !== null,
          signature: delivery.signature,
        };
      });
  };

  return { recordOf, receipt, deliveries };
}
