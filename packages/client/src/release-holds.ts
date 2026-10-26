import type { Address, Signature } from "@solana/kit";
import { IntentStatus, type WithheldRole } from "@intent-engine/core";
import { withheldRole } from "@intent-engine/core/internal";
import { loadAnnouncement } from "./announcement-reads.js";
import { type HeldClaim, heldBit, heldClaimsIn, heldIn, type HeldInRelease } from "./held-shares.js";
import { intentAt } from "./job-proofs.js";
import { scan } from "./job-scan.js";
import { engineEvents } from "./release-reads.js";
import type { EngineTransaction, Transport } from "./transport.js";

export type HeldState = "held" | "received" | "returned";

export type HeldPayout = {
  wallet: Address;
  account: Address;
  announcement: Address;
  index: number;
  amount: bigint;
  state: HeldState;
  received: boolean;
  claimedTo: Address | null;
  claim: Signature | null;
  returnedTo: Address | null;
  close: Signature | null;
};

export type WithheldFee = { role: WithheldRole | "unknown"; payee: Address; account: Address; amount: bigint };

export type HeldReturn = { owner: Address; refundTo: Address; swept: bigint; signature: Signature };

export function withheldIn(release: EngineTransaction, by: Address, intent: Address): WithheldFee[] {
  return engineEvents([release], by, intent).flatMap(({ event }) =>
    event.name === "FeeWithheld" ? [{ role: withheldRole(event.fields.role), payee: event.fields.payee, account: event.fields.account, amount: event.fields.fee }] : [],
  );
}

type Close = { transaction: EngineTransaction; refundTo: Address; swept: bigint };

const after = (transaction: EngineTransaction, release: EngineTransaction): boolean =>
  transaction.signature !== release.signature &&
  transaction.slot >= release.slot &&
  (transaction.blockTime === null || release.blockTime === null || transaction.blockTime > release.blockTime || transaction.slot > release.slot);

const earlier = (a: EngineTransaction, b: EngineTransaction): boolean => a.slot < b.slot || (a.slot === b.slot && a.blockTime !== null && b.blockTime !== null && a.blockTime < b.blockTime);

export function closeAfter(history: readonly EngineTransaction[], release: EngineTransaction, by: Address, intent: Address, owner: Address): HeldReturn | null {
  let first: Close | undefined;
  for (const { event, transaction } of engineEvents(history, by, intent)) {
    if (event.name !== "IntentClosed" || event.fields.owner !== owner || !after(transaction, release)) {
      continue;
    }
    const holder = transaction.tokens?.find(({ account }) => account === event.fields.refundTo)?.owner;
    if ((holder === undefined || holder === owner) && (first === undefined || earlier(transaction, first.transaction))) {
      first = { transaction, refundTo: event.fields.refundTo, swept: event.fields.swept };
    }
  }
  return first === undefined ? null : { owner, refundTo: first.refundTo, swept: first.swept, signature: first.transaction.signature as Signature };
}

export const CLOSE_PAGES = 10;

async function closeOf(transport: Transport, release: EngineTransaction, by: Address, intent: Address, owner: Address, history: readonly EngineTransaction[]): Promise<HeldReturn | null> {
  const known = closeAfter(history, release, by, intent, owner);
  if (known !== null) {
    return known;
  }
  const scanned = await scan(transport, intent, { pages: CLOSE_PAGES, until: (transaction) => transaction.signature === release.signature });
  return closeAfter(scanned.transactions, release, by, intent, owner);
}

function ownerOf(release: EngineTransaction, by: Address, intent: Address): Address | null {
  const settled = engineEvents([release], by, intent).find(({ event }) => event.name === "IntentSplit")?.event;
  return settled?.name === "IntentSplit" ? settled.fields.owner : null;
}

async function escrowOpen(transport: Transport, release: EngineTransaction, intent: Address): Promise<boolean> {
  const current = await intentAt(transport, intent);
  return current !== null && current.status === IntentStatus.Filled && (release.blockTime === null || current.createdAt <= release.blockTime);
}

type Pending = { share: HeldInRelease; unclaimed: boolean; claimed: HeldClaim | undefined };

export async function heldPayouts(transport: Transport, release: EngineTransaction, by: Address, intent: Address, history: readonly EngineTransaction[]): Promise<HeldPayout[]> {
  const held = heldIn(release, by, intent);
  if (held.length === 0) {
    return [];
  }
  const claims = heldClaimsIn(history, by, intent);
  const announcements = new Map<Address, Awaited<ReturnType<typeof loadAnnouncement>>>();
  let open: boolean | undefined;
  const pending: Pending[] = [];
  for (const share of held) {
    const claimed = claims.find(({ announcement, index }) => announcement === share.announcement && index === share.index);
    if (claimed !== undefined) {
      pending.push({ share, unclaimed: false, claimed });
      continue;
    }
    if (!announcements.has(share.announcement)) {
      announcements.set(share.announcement, await loadAnnouncement(transport, share.announcement));
    }
    const view = announcements.get(share.announcement) ?? null;
    open ??= await escrowOpen(transport, release, intent);
    pending.push({ share, unclaimed: view === null ? !open : heldBit(view.held, share.index), claimed: undefined });
  }
  const owner = ownerOf(release, by, intent);
  const unclaimed = pending.reduce((sum, entry) => (entry.unclaimed ? sum + entry.share.amount : sum), 0n);
  const close = unclaimed === 0n || open !== false || owner === null ? null : await closeOf(transport, release, by, intent, owner, history);
  const returned = close !== null && close.swept >= unclaimed ? close : null;
  return pending.map(({ share, unclaimed: still, claimed }) => {
    const state: HeldState = !still ? "received" : returned === null ? "held" : "returned";
    return {
      wallet: share.wallet,
      account: share.account,
      announcement: share.announcement,
      index: share.index,
      amount: share.amount,
      state,
      received: state === "received",
      claimedTo: claimed?.to ?? null,
      claim: claimed?.signature ?? null,
      returnedTo: state === "returned" && returned !== null ? returned.refundTo : null,
      close: state === "returned" && returned !== null ? returned.signature : null,
    };
  });
}

const totalOf = (held: readonly HeldPayout[], state: HeldState, wallet?: Address): bigint =>
  held.reduce((sum, share) => (share.state === state && (wallet === undefined || share.wallet === wallet) ? sum + share.amount : sum), 0n);

export const heldWaiting = (held: readonly HeldPayout[], wallet?: Address): bigint => totalOf(held, "held", wallet);

export const heldReturned = (held: readonly HeldPayout[], wallet?: Address): bigint => totalOf(held, "returned", wallet);

function heldLine(share: HeldPayout): string {
  switch (share.state) {
    case "received":
      return `${share.wallet} received its held share of ${share.amount} raw units${share.claimedTo === null ? "" : ` in ${share.claimedTo}`}`;
    case "returned":
      return `${share.amount} raw units held for ${share.wallet} were returned to the escrow's owner in ${share.returnedTo ?? "its refund account"} when the escrow closed in ${share.close ?? "an unread transaction"}, as ${share.wallet} never claimed them`;
    case "held":
      return `${share.amount} raw units are paid to ${share.wallet} but held in the escrow until it claims them, as ${share.account} could not take them`;
  }
}

export const heldSummary = (held: readonly HeldPayout[]): string[] => held.map(heldLine);

export const withheldSummary = (withheld: readonly WithheldFee[]): string[] =>
  withheld.map((fee) => `the ${fee.role} fee of ${fee.amount} raw units was withheld, as ${fee.account} of ${fee.payee} could not take it, and stays with the escrow's owner`);
export { eventAuthority } from "./release-reads.js";
