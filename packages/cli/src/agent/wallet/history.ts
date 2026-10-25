import type { Address } from "@solana/kit";
import { formatAmount, Kind, kindName, tokenName } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { type HistoryEvent, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { mintOf, ownHistory, paidWalletsOf, transactionAt } from "@intent-engine/client/internal";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { account, amount, choice, flag, integer, list, nullable, object, optional, text, time } from "../schema.js";
import { signerOf } from "./guard.js";
import { claimItem, claimsOf, type Kept, OWN_TRANSACTIONS, workItem, workOf } from "./history-work.js";
import { PAID_FROM_INPUT, PAID_FROM_MAX, profitItem, profitOf } from "./history-profit.js";

export const HISTORY_DEFAULT = 10;
export const HISTORY_MAX = 25;
export const RANGE_SCAN = 100;
const EVENTS_PER_INTENT = 20;

const OUTCOMES = ["open", "filled", "released", "cancelled", "expired", "unknown"] as const;
type Outcome = (typeof OUTCOMES)[number];

type Fields = Record<string, unknown>;
const fields = (event: HistoryEvent | undefined): Fields => (event?.fields ?? {}) as Fields;

const ENDINGS: Readonly<Record<string, Outcome>> = {
  IntentFilled: "filled",
  FillEnded: "filled",
  IntentAttested: "released",
  IntentSplit: "released",
  IntentCancelled: "cancelled",
  IntentExpired: "expired",
};

type Range = { escrow?: Address | undefined; since?: bigint | undefined; until?: bigint | undefined };

const inRange = (range: Range, intent: Address, at: bigint | null): boolean =>
  (range.escrow === undefined || intent === range.escrow) &&
  (range.since === undefined || (at !== null && at >= range.since)) &&
  (range.until === undefined || (at !== null && at <= range.until));

async function paidWalletOf(transport: Transport, ending: HistoryEvent, intent: Address): Promise<Address | null> {
  const { signature, slot, blockTime } = ending;
  const transaction = (await transactionAt(transport, signature, intent)) ?? { signature, slot, blockTime, failed: false, emitted: [] };
  return (await paidWalletsOf(transport, { event: ending, transaction }, intent))?.[0] ?? null;
}

export const walletHistory = define({
  name: tool("wallet_history"),
  title: "Show the wallet's history",
  description: `Shows this wallet's history from the chain: intents it created and how each ended; work it announced with ${tool("wallet_deliver")} and whether a release paid it; claims it took, dropped or queued for, with each stake's outcome. escrow, since and until narrow the lists; paid_from adds profit: a job's pay less its sub-escrows' cost. Leaves out transfers and releases it judged.`,
  effect: "read",
  input: object({
    limit: optional(integer(1, HISTORY_MAX, `how many of the newest intents, and of the newest announcements and claims, to show; default ${HISTORY_DEFAULT}`)),
    escrow: optional(account("list only this escrow's intent, announcements and claims; with paid_from, the job this wallet was paid for")),
    since: optional(time("list only what happened at or after these unix seconds")),
    until: optional(time("list only what happened at or before these unix seconds")),
    paid_from: optional(list(account(), PAID_FROM_MAX, PAID_FROM_INPUT, 1)),
  }),
  output: object({
    wallet: account("this server's wallet, whose history this is"),
    activity: list(
      object({
        nonce: amount("the intent's nonce, its number among this wallet's intents"),
        intent: account("the intent's address"),
        kind: text("the kind of intent, such as AttestedResult for an escrow or SwapExactIn for a swap"),
        outcome: choice(OUTCOMES, "how it ended: open, filled, released, cancelled, expired, or unknown when its history was not found"),
        sold: text("whole tokens the intent escrowed"),
        sell_token: text("SOL, TEST or the mint"),
        received: nullable(text("whole tokens delivered by the fill")),
        receive_token: nullable(text("SOL, TEST or the mint a fill delivers; null for a work escrow, which pays a worker and receives nothing")),
        paid_to: nullable(account("the wallet a release paid: the owner of payee")),
        payee: nullable(account("the token account a release paid into, owned by paid_to; for SOL it holds wrapped SOL")),
        signature: nullable(text("the transaction that ended it")),
        at: nullable(time("unix seconds of the last event, when the cluster reports it")),
      }),
      HISTORY_MAX,
      "the intents this wallet created, newest first",
    ),
    more: flag("true when older intents exist beyond limit"),
    work: list(workItem, HISTORY_MAX, `the work this wallet announced with ${tool("wallet_deliver")}, newest first`),
    claims: list(claimItem, HISTORY_MAX, "the claims this wallet took, dropped or queued for, released escrows included, newest first"),
    more_work: flag(`true when older announcements or claims exist beyond limit, or this wallet has transactions older than the newest ${OWN_TRANSACTIONS} read`),
    profit: optional(profitItem),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = (await signerOf(ctx)).address;
    const profit = input.paid_from === undefined ? undefined : await profitOf(ctx.transport, wallet, input.escrow, input.paid_from);
    const client = createClient({ url: ctx.url ?? "http://cluster", transport: ctx.transport });
    const next = await client.nextNonce(wallet);
    const limit = BigInt(input.limit ?? HISTORY_DEFAULT);
    const ranged = input.since !== undefined || input.until !== undefined;
    const range: Range = { escrow: input.escrow, since: input.since, until: input.until };
    const decimals = new Map<Address, number>();
    const tokens = async (mint: Address, raw: bigint) => {
      if (!decimals.has(mint)) {
        decimals.set(mint, (await mintOf(ctx.transport, mint)).decimals);
      }
      return formatAmount(raw, decimals.get(mint) ?? 0);
    };
    const activityOf = async (intent: Address, nonce: bigint | undefined) => {
      const events = (await client.history(intent, { limit: EVENTS_PER_INTENT })).events;
      const created = fields(events.find((e) => e.name === "IntentCreated"));
      const inputMint = created["inputMint"] as Address | undefined;
      const outputMint = created["outputMint"] as Address | undefined;
      if (inputMint === undefined || outputMint === undefined || (nonce === undefined && created["owner"] !== wallet)) {
        return undefined;
      }
      const kind = Number(created["kind"]);
      const ending = events.find((e) => e.name in ENDINGS);
      const outcome: Outcome = ending === undefined ? ((await ctx.transport.getAccount(intent)) === null ? "unknown" : "open") : (ENDINGS[ending.name] ?? "unknown");
      const ended = fields(ending);
      const delivered = outcome === "filled" ? (ended["delivered"] as bigint | undefined) : undefined;
      const attested = ending?.name === "IntentAttested" ? ending : undefined;
      return {
        nonce: nonce ?? (created["nonce"] as bigint),
        intent,
        kind: kindName(kind) ?? "unknown",
        outcome,
        sold: await tokens(inputMint, created["escrowed"] as bigint),
        sell_token: tokenName(inputMint) ?? inputMint,
        received: delivered === undefined ? null : await tokens(outputMint, delivered),
        receive_token: kind === Kind.AttestedResult ? null : (tokenName(outputMint) ?? outputMint),
        paid_to: attested === undefined ? null : await paidWalletOf(ctx.transport, attested, intent),
        payee: attested === undefined ? null : attested.fields.payee,
        signature: ending?.signature ?? null,
        at: (ending ?? events[0])?.blockTime ?? null,
      };
    };
    type Activity = NonNullable<Awaited<ReturnType<typeof activityOf>>>;
    const activity: Activity[] = [];
    let more = false;
    if (input.escrow !== undefined) {
      const item = await activityOf(input.escrow, undefined);
      activity.push(...(item !== undefined && inRange(range, item.intent, item.at) ? [item] : []));
    } else {
      const oldest = next - (ranged ? BigInt(RANGE_SCAN) : limit);
      for (let nonce = next - 1n; nonce >= oldest && nonce >= 0n; nonce -= 1n) {
        if (BigInt(activity.length) === limit) {
          more = true;
          break;
        }
        const [intent] = await findIntentPda({ owner: wallet, nonce });
        const item = await activityOf(intent, nonce);
        if (item !== undefined && inRange(range, intent, item.at)) {
          activity.push(item);
        }
      }
      more ||= oldest > 0n;
    }
    const kept: Kept = ({ intent, blockTime }) => inRange(range, intent, blockTime);
    const own = await ownHistory(ctx.transport, wallet, OWN_TRANSACTIONS);
    const count = Number(limit);
    const { work, more: moreWork } = await workOf(ctx.transport, wallet, own.transactions, count, tokens, kept);
    const { claims, more: moreClaims } = await claimsOf(ctx.transport, wallet, own.transactions, count, kept);
    return { wallet, activity, more, work, claims, more_work: moreWork || moreClaims || !own.complete, ...(profit === undefined ? {} : { profit }) };
  },
});
