import type { Address } from "@solana/kit";
import { findIntentPda, formatAmount, kindName, tokenName } from "@intent-engine/core";
import { createClient, type HistoryEvent, mintOf } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { account, amount, choice, flag, integer, list, nullable, object, optional, text, time } from "../schema.js";
import { signerOf } from "./guard.js";

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

export const walletHistory = define({
  name: tool("wallet_history"),
  title: "Show the wallet's history",
  description: `Show what this server's wallet did, newest first: each intent it created, what it sold, and how it ended (filled with what it received, released to whom, cancelled, expired, or still open), read from the chain. Finished intents are included even after their accounts closed. Use it to answer "what have I done".`,
  effect: "read",
  input: object({ limit: optional(integer(1, HISTORY_MAX, `how many of the newest intents to show; default ${HISTORY_DEFAULT}`)) }),
  output: object({
    wallet: account(),
    activity: list(
      object({
        nonce: amount(),
        intent: account(),
        kind: text(),
        outcome: choice(OUTCOMES),
        sold: text("whole tokens the intent escrowed"),
        sell_token: text("SOL, TEST or the mint"),
        received: nullable(text("whole tokens delivered by the fill")),
        receive_token: text("SOL, TEST or the mint"),
        paid_to: nullable(account("the wallet a release paid")),
        signature: nullable(text("the transaction that ended it")),
        at: nullable(time("unix seconds of the last event, when the cluster reports it")),
      }),
      HISTORY_MAX,
    ),
    more: flag("true when older intents exist beyond limit"),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = (await signerOf(ctx)).address;
    const client = createClient({ url: ctx.url ?? "http://cluster", transport: ctx.transport });
    const next = await client.nextNonce(wallet);
    const limit = BigInt(input.limit ?? HISTORY_DEFAULT);
    const oldest = next > limit ? next - limit : 0n;
    const decimals = new Map<Address, number>();
    const tokens = async (mint: Address, raw: bigint) => {
      if (!decimals.has(mint)) {
        decimals.set(mint, (await mintOf(ctx.transport, mint)).decimals);
      }
      return formatAmount(raw, decimals.get(mint) ?? 0);
    };
    const activity = [];
    for (let nonce = next - 1n; nonce >= oldest; nonce -= 1n) {
      const [intent] = await findIntentPda({ owner: wallet, nonce });
      const events = await client.history(intent, EVENTS_PER_INTENT);
      const created = fields(events.find((e) => e.name === "IntentCreated"));
      const inputMint = created["inputMint"] as Address | undefined;
      const outputMint = created["outputMint"] as Address | undefined;
      if (inputMint === undefined || outputMint === undefined) {
        continue;
      }
      const ending = events.find((e) => e.name in ENDINGS);
      const outcome: Outcome = ending === undefined ? ((await ctx.transport.getAccount(intent)) === null ? "unknown" : "open") : (ENDINGS[ending.name] ?? "unknown");
      const ended = fields(ending);
      const delivered = outcome === "filled" ? (ended["delivered"] as bigint | undefined) : undefined;
      activity.push({
        nonce,
        intent,
        kind: kindName(Number(created["kind"])) ?? "unknown",
        outcome,
        sold: await tokens(inputMint, created["escrowed"] as bigint),
        sell_token: tokenName(inputMint) ?? inputMint,
        received: delivered === undefined ? null : await tokens(outputMint, delivered),
        receive_token: tokenName(outputMint) ?? outputMint,
        paid_to: ending?.name === "IntentAttested" ? (ended["payee"] as Address) : null,
        signature: ending?.signature ?? null,
        at: (ending ?? events[0])?.blockTime ?? null,
      });
    }
    return { wallet, activity, more: oldest > 0n };
  },
});
