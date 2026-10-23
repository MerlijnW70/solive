import type { Address } from "@solana/kit";
import { findIntentPda, formatAmount, Kind, kindName, tokenName } from "@intent-engine/core";
import { createClient, type HistoryEvent, mintOf, ownHistory, paidWalletsOf, transactionAt, type Transport } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { account, amount, choice, flag, integer, list, nullable, object, optional, text, time } from "../schema.js";
import { signerOf } from "./guard.js";
import { claimItem, claimsOf, OWN_TRANSACTIONS, workItem, workOf } from "./history-work.js";

export const HISTORY_DEFAULT = 10;
export const HISTORY_MAX = 25;
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

async function paidWalletOf(transport: Transport, ending: HistoryEvent, intent: Address): Promise<Address | null> {
  const { signature, slot, blockTime } = ending;
  const transaction = (await transactionAt(transport, signature, intent)) ?? { signature, slot, blockTime, failed: false, emitted: [] };
  return (await paidWalletsOf(transport, { event: ending, transaction }, intent))?.[0] ?? null;
}

export const walletHistory = define({
  name: tool("wallet_history"),
  title: "Show the wallet's history",
  description: `Shows the user what this wallet did, newest first, read from the chain: orders (intents) it created and how each ended, closed ones included; work it announced with ${tool("wallet_deliver")} whether a release paid it, and why not; claims it took or dropped and the stake's outcome. It leaves out transfers, releases it judged, fills of others' orders, and standby lines.`,
  effect: "read",
  input: object({
    limit: optional(integer(1, HISTORY_MAX, `how many of the newest intents, and of the newest announcements and claims, to show; default ${HISTORY_DEFAULT}`)),
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
    claims: list(claimItem, HISTORY_MAX, "the claims this wallet took or dropped, newest first"),
    more_work: flag(`true when older announcements or claims exist beyond limit, or this wallet has transactions older than the newest ${OWN_TRANSACTIONS} read`),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = (await signerOf(ctx)).address;
    const client = createClient({ url: ctx.url ?? "http://cluster", transport: ctx.transport });
    const next = await client.nextNonce(wallet);
    const limit = BigInt(input.limit ?? HISTORY_DEFAULT);
    const oldest = next - limit;
    const decimals = new Map<Address, number>();
    const tokens = async (mint: Address, raw: bigint) => {
      if (!decimals.has(mint)) {
        decimals.set(mint, (await mintOf(ctx.transport, mint)).decimals);
      }
      return formatAmount(raw, decimals.get(mint) ?? 0);
    };
    const activity = [];
    for (let nonce = next - 1n; nonce >= oldest && nonce >= 0n; nonce -= 1n) {
      const [intent] = await findIntentPda({ owner: wallet, nonce });
      const events = await client.history(intent, EVENTS_PER_INTENT);
      const created = fields(events.find((e) => e.name === "IntentCreated"));
      const inputMint = created["inputMint"] as Address | undefined;
      const outputMint = created["outputMint"] as Address | undefined;
      if (inputMint === undefined || outputMint === undefined) {
        continue;
      }
      const kind = Number(created["kind"]);
      const ending = events.find((e) => e.name in ENDINGS);
      const outcome: Outcome = ending === undefined ? ((await ctx.transport.getAccount(intent)) === null ? "unknown" : "open") : (ENDINGS[ending.name] ?? "unknown");
      const ended = fields(ending);
      const delivered = outcome === "filled" ? (ended["delivered"] as bigint | undefined) : undefined;
      const attested = ending?.name === "IntentAttested" ? ending : undefined;
      activity.push({
        nonce,
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
      });
    }
    const own = await ownHistory(ctx.transport, wallet, OWN_TRANSACTIONS);
    const count = Number(limit);
    const { work, more: moreWork } = await workOf(ctx.transport, wallet, own.transactions, count, tokens);
    const { claims, more: moreClaims } = await claimsOf(ctx.transport, wallet, own.transactions, count);
    return { wallet, activity, more: oldest > 0n, work, claims, more_work: moreWork || moreClaims || !own.complete };
  },
});
