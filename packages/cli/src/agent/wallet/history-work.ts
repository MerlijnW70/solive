import type { Address } from "@solana/kit";
import { type EngineEvent, formatAmount, IntentStatus, tokenName } from "@intent-engine/core";
import { decodeEvent } from "@intent-engine/core/internal";
import { type EngineTransaction, type Transport } from "@intent-engine/client";
import { chainTime, eventAuthority, heldPayouts, intentAt, loadClaimsOf, paidWalletsOf, releaseShareOf } from "@intent-engine/client/internal";
import { tool } from "../names.js";
import { account, choice, flag, nullable, object, optional, text, time } from "../schema.js";
import { createdMint, heldMint, type ReleaseLookup, releaseLookup, releasedMint } from "./releases.js";
import { deliveryReleased } from "./standing.js";

export const OWN_TRANSACTIONS = 250;
const ESCROW_EVENTS = 20;
export const STAKE_TO_WORKER = 0;
export const SOL_DECIMALS = 9;

export const STAKE_OUTCOMES = ["held", "returned", "forfeited", "unknown"] as const;
type StakeOutcome = (typeof STAKE_OUTCOMES)[number];

export const UNPAID_REASONS = ["released_to_other", "open", "cancelled", "expired", "unknown"] as const;
type UnpaidReason = (typeof UNPAID_REASONS)[number];

const CLAIM_ACTIONS = ["claimed", "dropped", "queued", "left"] as const;
type ClaimAction = (typeof CLAIM_ACTIONS)[number];

const landedAt = (what: string) => nullable(time(`unix seconds ${what} landed, when the cluster reports it`));

export const workItem = object({
  intent: account("the escrow the work was announced to"),
  announcement: account("the announcement account"),
  signature: text("the announcement's transaction"),
  at: landedAt("the announcement"),
  paid: flag("whether a release of the escrow paid this announcement, or paid this wallet as a co-author of the paid one"),
  amount: nullable(text("whole tokens the release paid this wallet")),
  token: nullable(text("SOL, TEST or the mint the release paid")),
  release: nullable(text("the release's transaction")),
  held: optional(text(`whole tokens of this wallet's paid share that the release held in the escrow because its token account could not take them, not claimed yet; ${tool("wallet_claim_held")} claims them`)),
  unpaid_reason: nullable(
    choice(
      UNPAID_REASONS,
      "null when paid; released_to_other: a release paid released_to, not this wallet; open: the escrow is still open; cancelled or expired: it ended unpaid; unknown: not found",
    ),
  ),
  released_to: nullable(account("with released_to_other: the wallet the release paid; for a split, its first recipient")),
});

export const claimItem = object({
  intent: account("the escrow whose claim this wallet took, dropped or queued for"),
  action: choice(CLAIM_ACTIONS, "claimed: this wallet took the claim, or was handed it from the line; dropped: it gave the claim up; queued: it stood by in the line; left: it left the line"),
  stake: text("whole SOL the claim or place in line staked, or that dropping or leaving returned"),
  stake_outcome: choice(
    STAKE_OUTCOMES,
    "held: the stake still sits on the claim or in the line; returned: it went back to this wallet; forfeited: it went to the escrow's owner; unknown: what became of it was not found",
  ),
  signature: text("the transaction that took, dropped or queued for the claim, or left the line"),
  at: landedAt("the claim, drop, queue or leave"),
});

type Tokens = (mint: Address, raw: bigint) => Promise<string>;

export type Kept = (item: { intent: Address; blockTime: bigint | null }) => boolean;

const everything: Kept = () => true;

type Landed = { signature: string; slot: bigint; blockTime: bigint | null };

const earlier = (a: Landed, b: Landed): boolean => a.slot < b.slot || (a.slot === b.slot && a.signature < b.signature);

type Announcement = Landed & { intent: Address; announcement: Address };

function announcedIn(transactions: readonly EngineTransaction[], wallet: Address): Announcement[] {
  return eventsIn(transactions).flatMap((event): Announcement[] =>
    event.name === "DeliveryAnnounced" && event.fields.worker === wallet
      ? [{ intent: event.fields.intent, announcement: event.fields.announcement, signature: event.signature, slot: event.slot, blockTime: event.blockTime }]
      : [],
  );
}

const newestFirst = <T extends { slot: bigint }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.slot === b.slot ? 0 : a.slot < b.slot ? 1 : -1));

export function eventsIn(transactions: readonly EngineTransaction[]): (EngineEvent & Landed)[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap(({ signature, slot, blockTime, emitted }) =>
      emitted.map((data) => decodeEvent(data) as EngineEvent | null).flatMap((event) => (event === null ? [] : [{ ...event, signature, slot, blockTime }])),
    );
}

async function paidFor(transport: Transport, work: Announcement, wallet: Address, lookup: ReleaseLookup, tokens: Tokens) {
  const { release, transactions } = lookup;
  if (release === null) {
    return null;
  }
  const event = release.event as EngineEvent;
  if (event.name !== "IntentAttested" && event.name !== "IntentSplit") {
    return null;
  }
  const paidWork = deliveryReleased(release.tx, work.intent);
  if (paidWork === null || (paidWork.announcement !== work.announcement && event.name === "IntentAttested")) {
    return null;
  }
  const share = await releaseShareOf(transport, { event, transaction: release.tx }, work.intent, wallet);
  if (share === null) {
    return null;
  }
  const payee = event.name === "IntentAttested" ? event.fields.payee : undefined;
  const mint = releasedMint(release.tx, work.intent, payee) ?? createdMint(transactions, work.intent) ?? (await heldMint(transport, work.intent));
  const held = event.name === "IntentSplit" ? await heldPayouts(transport, release.tx, await eventAuthority(), work.intent, transactions) : [];
  const waiting = held.filter((piece) => piece.wallet === wallet && !piece.received).reduce((sum, piece) => sum + piece.amount, 0n);
  return {
    amount: mint === undefined ? null : await tokens(mint, share),
    token: mint === undefined ? null : (tokenName(mint) ?? mint),
    release: release.tx.signature,
    ...(waiting === 0n || mint === undefined ? {} : { held: await tokens(mint, waiting) }),
  };
}

type Unpaid = { reason: UnpaidReason; releasedTo: Address | null };

const ENDED: Readonly<Record<string, UnpaidReason>> = { IntentCancelled: "cancelled", IntentExpired: "expired" };

async function unpaidOf(transport: Transport, intent: Address, wallet: Address, lookup: ReleaseLookup): Promise<Unpaid> {
  const { release, transactions } = lookup;
  if (release !== null) {
    const wallets = await paidWalletsOf(transport, { event: release.event as EngineEvent, transaction: release.tx }, intent);
    const [first] = wallets ?? [];
    return wallets === null || first === undefined || wallets.includes(wallet) ? { reason: "unknown", releasedTo: null } : { reason: "released_to_other", releasedTo: first };
  }
  const held = await intentAt(transport, intent);
  if (held !== null && held.status === IntentStatus.Open) {
    return { reason: held.expiresAt > (await chainTime(transport)) ? "open" : "expired", releasedTo: null };
  }
  const ending = eventsIn(transactions).find((event) => event.name in ENDED && (event.fields as Record<string, unknown>)["intent"] === intent);
  return { reason: ending === undefined ? "unknown" : (ENDED[ending.name] ?? "unknown"), releasedTo: null };
}

export async function workOf(transport: Transport, wallet: Address, transactions: readonly EngineTransaction[], limit: number, tokens: Tokens, kept: Kept = everything) {
  const announced = newestFirst(announcedIn(transactions, wallet).filter((work) => kept(work)));
  const lookups = new Map<Address, Promise<ReleaseLookup>>();
  const work = [];
  for (const delivery of announced.slice(0, limit)) {
    const { intent } = delivery;
    const announcement = delivery.announcement;
    const lookup = lookups.get(intent) ?? releaseLookup(transport, intent);
    lookups.set(intent, lookup);
    const paid = await paidFor(transport, delivery, wallet, await lookup, tokens);
    const unpaid = paid === null ? await unpaidOf(transport, intent, wallet, await lookup) : { reason: null, releasedTo: null };
    work.push({
      intent,
      announcement,
      signature: delivery.signature,
      at: delivery.blockTime,
      paid: paid !== null,
      amount: paid?.amount ?? null,
      token: paid?.token ?? null,
      release: paid?.release ?? null,
      ...(paid?.held === undefined ? {} : { held: paid.held }),
      unpaid_reason: unpaid.reason,
      released_to: unpaid.releasedTo,
    });
  }
  return { work, more: announced.length > limit };
}

type Claim = Landed & { intent: Address; action: ClaimAction; stake: bigint };
type StakeEnd = Landed & { outcome: StakeOutcome };

const keyOf = ({ signature, action, intent }: Claim): string => `${signature}:${action}:${intent}`;

function claimsIn(transactions: readonly EngineTransaction[], wallet: Address): Claim[] {
  return eventsIn(transactions).flatMap((event): Claim[] => {
    const { signature, slot, blockTime } = event;
    if (event.name === "JobClaimed" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "claimed", stake: event.fields.stake, signature, slot, blockTime }];
    }
    if (event.name === "ClaimDropped" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "dropped", stake: event.fields.refunded, signature, slot, blockTime }];
    }
    if (event.name === "StoodBy" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "queued", stake: event.fields.stake, signature, slot, blockTime }];
    }
    if (event.name === "LineLeft" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "left", stake: event.fields.refunded, signature, slot, blockTime }];
    }
    return [];
  });
}

function stakeEndsIn(transactions: readonly EngineTransaction[], wallet: Address, intent: Address): StakeEnd[] {
  return eventsIn(transactions).flatMap((event): StakeEnd[] => {
    const { signature, slot, blockTime } = event;
    if ((event.name === "ClaimDropped" || event.name === "LineLeft") && event.fields.worker === wallet && event.fields.intent === intent) {
      return [{ outcome: "returned", signature, slot, blockTime }];
    }
    if (event.name === "StakeMoved" && event.fields.worker === wallet && event.fields.intent === intent) {
      return [{ outcome: event.fields.role === STAKE_TO_WORKER ? "returned" : "forfeited", signature, slot, blockTime }];
    }
    return [];
  });
}

const firstAfter = <T extends Landed>(from: Landed, items: readonly T[]): T | undefined =>
  items.filter((item) => earlier(from, item)).reduce<T | undefined>((first, item) => (first === undefined || earlier(item, first) ? item : first), undefined);

async function heldBy(transport: Transport, wallet: Address, intents: readonly Address[]): Promise<Set<Address>> {
  try {
    const views = await loadClaimsOf(transport, intents);
    return new Set(intents.filter((_, at) => views[at]?.worker === wallet));
  } catch {
    return new Set();
  }
}

type Histories = (intent: Address) => Promise<EngineTransaction[]>;

function escrowHistories(transport: Transport): Histories {
  const read = new Map<Address, Promise<EngineTransaction[]>>();
  return (intent) => {
    const found = read.get(intent) ?? transport.engineTransactions(ESCROW_EVENTS, intent);
    read.set(intent, found);
    return found;
  };
}

async function allClaims(wallet: Address, transactions: readonly EngineTransaction[], history: Histories): Promise<Claim[]> {
  const own = claimsIn(transactions, wallet);
  const claimed = new Set(own.filter(({ action }) => action === "claimed").map(({ intent }) => intent));
  const queued = own.filter(({ action }) => action === "queued").map(({ intent }) => intent);
  const moved = eventsIn(transactions).flatMap((event) => (event.name === "StakeMoved" && event.fields.worker === wallet && !claimed.has(event.fields.intent) ? [event.fields.intent] : []));
  const seen = new Set(own.map(keyOf));
  const found = [...own];
  for (const intent of new Set([...queued, ...moved])) {
    for (const claim of claimsIn(await history(intent), wallet)) {
      if (claim.intent === intent && !seen.has(keyOf(claim))) {
        seen.add(keyOf(claim));
        found.push(claim);
      }
    }
  }
  return found;
}

async function outcomeOf(claim: Claim, wallet: Address, transactions: readonly EngineTransaction[], history: Histories, all: readonly Claim[]): Promise<StakeOutcome> {
  if (claim.action === "dropped" || claim.action === "left") {
    return "returned";
  }
  const end = firstAfter(claim, stakeEndsIn(transactions, wallet, claim.intent)) ?? firstAfter(claim, stakeEndsIn(await history(claim.intent), wallet, claim.intent));
  const handover = claim.action === "queued" ? firstAfter(claim, all.filter((later) => later.intent === claim.intent && later.action === "claimed")) : undefined;
  if (handover !== undefined && (end === undefined || earlier(handover, end))) {
    return outcomeOf(handover, wallet, transactions, history, all);
  }
  return end?.outcome ?? "unknown";
}

async function openLines(transport: Transport, intents: readonly Address[]): Promise<Set<Address>> {
  const open = new Set<Address>();
  for (const intent of intents) {
    const escrow = await intentAt(transport, intent);
    if (escrow !== null && escrow.status === IntentStatus.Open) {
      open.add(intent);
    }
  }
  return open;
}

export async function claimsOf(transport: Transport, wallet: Address, transactions: readonly EngineTransaction[], limit: number, kept: Kept = everything) {
  const history = escrowHistories(transport);
  const all = await allClaims(wallet, transactions, history);
  const found = newestFirst(all.filter(kept));
  const shown = found.slice(0, limit);
  const outcomes: StakeOutcome[] = [];
  for (const claim of shown) {
    outcomes.push(await outcomeOf(claim, wallet, transactions, history, all));
  }
  const unknown = (action: ClaimAction) => [...new Set(shown.filter((claim, at) => claim.action === action && outcomes[at] === "unknown").map(({ intent }) => intent))];
  const claimedOpen = unknown("claimed");
  const held = claimedOpen.length === 0 ? new Set<Address>() : await heldBy(transport, wallet, claimedOpen);
  const lines = await openLines(transport, unknown("queued"));
  const stillHeld = (claim: Claim): boolean => (claim.action === "claimed" ? held : lines).has(claim.intent);
  const claims = shown.map((claim, at) => ({
    intent: claim.intent,
    action: claim.action,
    stake: formatAmount(claim.stake, SOL_DECIMALS),
    stake_outcome: outcomes[at] === "unknown" && stillHeld(claim) ? ("held" as const) : (outcomes[at] ?? "unknown"),
    signature: claim.signature,
    at: claim.blockTime,
  }));
  return { claims, more: found.length > limit };
}
