import type { Address } from "@solana/kit";
import { decodeEvent, type EngineEvent, formatAmount, tokenName } from "@intent-engine/core";
import {
  type Delivery,
  deliveriesIn,
  earlier,
  type EngineTransaction,
  loadClaimsOf,
  opensWith,
  recordedRelease,
  releaseShareOf,
  type Transport,
} from "@intent-engine/client";
import { account, choice, flag, nullable, object, text, time } from "../schema.js";
import { createdMint, heldMint, type ReleaseLookup, releaseLookup, releasedMint } from "./releases.js";

export const OWN_TRANSACTIONS = 250;
const ESCROW_EVENTS = 20;
const STAKE_TO_WORKER = 0;
const SOL_DECIMALS = 9;

export const STAKE_OUTCOMES = ["held", "returned", "forfeited", "unknown"] as const;
type StakeOutcome = (typeof STAKE_OUTCOMES)[number];

const CLAIM_ACTIONS = ["claimed", "dropped"] as const;
type ClaimAction = (typeof CLAIM_ACTIONS)[number];

const landedAt = (what: string) => nullable(time(`unix seconds ${what} landed, when the cluster reports it`));

export const workItem = object({
  intent: account("the escrow the work was announced to"),
  signature: text("the announcement's transaction"),
  at: landedAt("the announcement"),
  paid: flag("whether a release of the escrow paid this wallet for this announcement"),
  amount: nullable(text("whole tokens the release paid this wallet")),
  token: nullable(text("SOL, TEST or the mint the release paid")),
  release: nullable(text("the release's transaction")),
});

export const claimItem = object({
  intent: account("the escrow whose claim this wallet took or dropped"),
  action: choice(CLAIM_ACTIONS, "claimed: this wallet took the claim; dropped: it gave the claim up"),
  stake: text("whole SOL the claim staked, or that dropping returned"),
  stake_outcome: choice(
    STAKE_OUTCOMES,
    "held: the stake still sits on the claim; returned: it went back to this wallet; forfeited: it went to the escrow's owner; unknown: what became of it was not found",
  ),
  signature: text("the transaction that took or dropped the claim"),
  at: landedAt("the claim or drop"),
});

type Tokens = (mint: Address, raw: bigint) => Promise<string>;

type Landed = { signature: string; slot: bigint; blockTime: bigint | null };

const newestFirst = <T extends { slot: bigint }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.slot === b.slot ? 0 : a.slot < b.slot ? 1 : -1));

function eventsIn(transactions: readonly EngineTransaction[]): (EngineEvent & Landed)[] {
  return transactions
    .filter(({ failed }) => !failed)
    .flatMap(({ signature, slot, blockTime, emitted }) =>
      emitted.map((data) => decodeEvent(data) as EngineEvent | null).flatMap((event) => (event === null ? [] : [{ ...event, signature, slot, blockTime }])),
    );
}

async function paidFor(transport: Transport, delivery: Delivery, wallet: Address, lookup: ReleaseLookup, tokens: Tokens) {
  const { release, transactions } = lookup;
  if (release === null || !earlier(delivery, release.tx)) {
    return null;
  }
  const event = release.event as EngineEvent;
  if (event.name !== "IntentAttested" && event.name !== "IntentSplit") {
    return null;
  }
  const recorded = recordedRelease(transactions, release.tx, event.fields.attestor);
  if (recorded?.salt !== undefined && !opensWith(delivery, recorded.salt, recorded.sha256)) {
    return null;
  }
  const share = await releaseShareOf(transport, { event, transaction: release.tx }, delivery.intent, wallet);
  if (share === null) {
    return null;
  }
  const payee = event.name === "IntentAttested" ? event.fields.payee : undefined;
  const mint = releasedMint(release.tx, delivery.intent, payee) ?? createdMint(transactions, delivery.intent) ?? (await heldMint(transport, delivery.intent));
  return {
    amount: mint === undefined ? null : await tokens(mint, share),
    token: mint === undefined ? null : (tokenName(mint) ?? mint),
    release: release.tx.signature,
  };
}

export async function workOf(transport: Transport, wallet: Address, transactions: readonly EngineTransaction[], limit: number, tokens: Tokens) {
  const announced = newestFirst(deliveriesIn(transactions).filter(({ worker }) => worker === wallet));
  const lookups = new Map<Address, Promise<ReleaseLookup>>();
  const work = [];
  for (const delivery of announced.slice(0, limit)) {
    const { intent } = delivery;
    const lookup = lookups.get(intent) ?? releaseLookup(transport, intent);
    lookups.set(intent, lookup);
    const paid = await paidFor(transport, delivery, wallet, await lookup, tokens);
    work.push({
      intent,
      signature: delivery.signature,
      at: delivery.blockTime,
      paid: paid !== null,
      amount: paid?.amount ?? null,
      token: paid?.token ?? null,
      release: paid?.release ?? null,
    });
  }
  return { work, more: announced.length > limit };
}

type Claim = Landed & { intent: Address; action: ClaimAction; stake: bigint };
type StakeEnd = Landed & { outcome: StakeOutcome };

function claimsIn(transactions: readonly EngineTransaction[], wallet: Address): Claim[] {
  return eventsIn(transactions).flatMap((event): Claim[] => {
    const { signature, slot, blockTime } = event;
    if (event.name === "JobClaimed" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "claimed", stake: event.fields.stake, signature, slot, blockTime }];
    }
    if (event.name === "ClaimDropped" && event.fields.worker === wallet) {
      return [{ intent: event.fields.intent, action: "dropped", stake: event.fields.refunded, signature, slot, blockTime }];
    }
    return [];
  });
}

function stakeEndsIn(transactions: readonly EngineTransaction[], wallet: Address, intent: Address): StakeEnd[] {
  return eventsIn(transactions).flatMap((event): StakeEnd[] => {
    const { signature, slot, blockTime } = event;
    if (event.name === "ClaimDropped" && event.fields.worker === wallet && event.fields.intent === intent) {
      return [{ outcome: "returned", signature, slot, blockTime }];
    }
    if (event.name === "StakeMoved" && event.fields.worker === wallet && event.fields.intent === intent) {
      return [{ outcome: event.fields.role === STAKE_TO_WORKER ? "returned" : "forfeited", signature, slot, blockTime }];
    }
    return [];
  });
}

const endAfter = (claim: Claim, ends: readonly StakeEnd[]): StakeEnd | undefined =>
  ends.filter((end) => earlier(claim, end)).reduce<StakeEnd | undefined>((first, end) => (first === undefined || earlier(end, first) ? end : first), undefined);

async function heldBy(transport: Transport, wallet: Address, intents: readonly Address[]): Promise<Set<Address>> {
  try {
    const views = await loadClaimsOf(transport, intents);
    return new Set(intents.filter((_, at) => views[at]?.worker === wallet));
  } catch {
    return new Set();
  }
}

export async function claimsOf(transport: Transport, wallet: Address, transactions: readonly EngineTransaction[], limit: number) {
  const found = newestFirst(claimsIn(transactions, wallet));
  const shown = found.slice(0, limit);
  const histories = new Map<Address, EngineTransaction[]>();
  const outcomes: StakeOutcome[] = [];
  for (const claim of shown) {
    if (claim.action === "dropped") {
      outcomes.push("returned");
      continue;
    }
    let end = endAfter(claim, stakeEndsIn(transactions, wallet, claim.intent));
    if (end === undefined) {
      const history = histories.get(claim.intent) ?? (await transport.engineTransactions(ESCROW_EVENTS, claim.intent));
      histories.set(claim.intent, history);
      end = endAfter(claim, stakeEndsIn(history, wallet, claim.intent));
    }
    outcomes.push(end?.outcome ?? "unknown");
  }
  const open = [...new Set(shown.filter((claim, at) => claim.action === "claimed" && outcomes[at] === "unknown").map(({ intent }) => intent))];
  const held = open.length === 0 ? new Set<Address>() : await heldBy(transport, wallet, open);
  const claims = shown.map((claim, at) => ({
    intent: claim.intent,
    action: claim.action,
    stake: formatAmount(claim.stake, SOL_DECIMALS),
    stake_outcome: outcomes[at] === "unknown" && held.has(claim.intent) ? ("held" as const) : (outcomes[at] ?? "unknown"),
    signature: claim.signature,
    at: claim.blockTime,
  }));
  return { claims, more: found.length > limit };
}
