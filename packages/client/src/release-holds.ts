import type { Address, Signature } from "@solana/kit";
import type { WithheldRole } from "@intent-engine/core";
import { withheldRole } from "@intent-engine/core/internal";
import { loadAnnouncement } from "./announcement-reads.js";
import { heldBit, heldClaimsIn, heldIn } from "./held-shares.js";
import { intentAt } from "./job-proofs.js";
import { engineEvents } from "./release-reads.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type HeldPayout = {
  wallet: Address;
  account: Address;
  announcement: Address;
  index: number;
  amount: bigint;
  received: boolean;
  claimedTo: Address | null;
  claim: Signature | null;
};

export type WithheldFee = { role: WithheldRole | "unknown"; payee: Address; account: Address; amount: bigint };

export function withheldIn(release: EngineTransaction, by: Address, intent: Address): WithheldFee[] {
  return engineEvents([release], by, intent).flatMap(({ event }) =>
    event.name === "FeeWithheld" ? [{ role: withheldRole(event.fields.role), payee: event.fields.payee, account: event.fields.account, amount: event.fields.fee }] : [],
  );
}

export async function heldPayouts(transport: Transport, release: EngineTransaction, by: Address, intent: Address, history: readonly EngineTransaction[]): Promise<HeldPayout[]> {
  const held = heldIn(release, by, intent);
  if (held.length === 0) {
    return [];
  }
  const claims = heldClaimsIn(history, by, intent);
  const announcements = new Map<Address, Awaited<ReturnType<typeof loadAnnouncement>>>();
  let escrowOpen: boolean | undefined;
  const payouts: HeldPayout[] = [];
  for (const share of held) {
    const claimed = claims.find(({ announcement, index }) => announcement === share.announcement && index === share.index);
    let received = claimed !== undefined;
    if (!received) {
      if (!announcements.has(share.announcement)) {
        announcements.set(share.announcement, await loadAnnouncement(transport, share.announcement));
      }
      const view = announcements.get(share.announcement) ?? null;
      escrowOpen ??= (await intentAt(transport, intent)) !== null;
      received = view === null ? escrowOpen : !heldBit(view.held, share.index);
    }
    payouts.push({
      wallet: share.wallet,
      account: share.account,
      announcement: share.announcement,
      index: share.index,
      amount: share.amount,
      received,
      claimedTo: claimed?.to ?? null,
      claim: claimed?.signature ?? null,
    });
  }
  return payouts;
}

export const heldSummary = (held: readonly HeldPayout[]): string[] =>
  held.map((share) =>
    share.received
      ? `${share.wallet} received its held share of ${share.amount} raw units${share.claimedTo === null ? "" : ` in ${share.claimedTo}`}`
      : `${share.amount} raw units are paid to ${share.wallet} but held in the escrow until it claims them, as ${share.account} could not take them`,
  );

export const withheldSummary = (withheld: readonly WithheldFee[]): string[] =>
  withheld.map((fee) => `the ${fee.role} fee of ${fee.amount} raw units was withheld, as ${fee.account} of ${fee.payee} could not take it, and stays with the escrow's owner`);
export { eventAuthority } from "./release-reads.js";
