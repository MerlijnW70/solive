import { formatAmount, formatTime, LONG_LIVED_SECONDS, WARN_LONG_LIVED } from "@intent-engine/core";
import { chainTime, mintOf } from "@intent-engine/client";
import { TOKEN_NAMES } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "../create.js";
import { tool } from "../names.js";
import { problemOf } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text, time } from "../schema.js";
import {
  ESTIMATE_SCAN,
  ESTIMATE_FILLS,
  DEFAULT_EXPIRES_IN,
  LANDING_SECONDS,
  access,
  testCluster,
  mintNamed,
  raw,
  salesOf,
  checkSale,
  checkHour,
  refusedBeforeSending,
  PREVIEW_FIRST,
} from "./guard.js";
import { offerFields, offerOutput, offered } from "./offer.js";
import { recentFills, bestOf, medianOf, openingAsk, type Fill } from "./fills.js";

export const SWAP_FALLS_OVER = 120;
export const PAY_TO = "the wallet that receives what is bought, such as someone this wallet pays; default this wallet. This wallet pays for its token account if it has none";

export const ORDER_DONE = `the order is placed; call ${tool("wallet_wait")} with its nonce (shown above, or from ${tool("wallet_intents")}) to see what it received, then check ${tool("wallet_balance")}`;

export const DEFAULT_SLIPPAGE_BPS = 100n;
export const MAX_SLIPPAGE_BPS = 5_000;
export const NO_MARKET = "no recent fills of this pair to set a floor from; pass min_receive, or call wallet_estimate first to see the price";

export function marketFloor(fills: Fill[], amount: bigint, slippageBps: number | undefined): bigint {
  const typical = medianOf(fills);
  if (typical === undefined || typical.amountIn === 0n) {
    throw new InvalidInput([{ path: "min_receive", message: NO_MARKET }]);
  }
  const slippage = BigInt(slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const floor = (amount * typical.delivered * (10_000n - slippage)) / (typical.amountIn * 10_000n);
  if (floor <= 0n) {
    throw new InvalidInput([{ path: "min_receive", message: NO_MARKET }]);
  }
  return floor;
}

export const walletSwap = define({
  name: tool("wallet_swap"),
  title: "Swap from the wallet",
  description: `Sells one token for another at the market: the simple sell, the ask falling to min_receive. Leave min_receive out to accept the recent median less max_slippage_bps. To buy, sell the other. For a price curve you set yourself, use ${tool("wallet_auction")}. ${PREVIEW_FIRST} Pass back the preview's start_receive.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    min_receive: optional(text("least whole tokens to receive for all of it; default the recent median less max_slippage_bps")),
    max_slippage_bps: optional(integer(1, MAX_SLIPPAGE_BPS, "how far below the recent median the default min_receive sits, in basis points; default 100 = 1%")),
    start_receive: optional(text("whole tokens asked when the offer lands; default a little above the median recent fill, between 1.25 and 2 times min_receive")),
    falls_over: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `seconds the ask takes to fall to min_receive; default ${SWAP_FALLS_OVER}`)),
    exact: optional(flag("true asks min_receive from the start, with no falling ask")),
    pay_to: optional(account(PAY_TO)),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the offer stays open once sent; default ${DEFAULT_EXPIRES_IN}`)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    ...offerFields,
    min_receive: optional(text("the floor the order will not sell below, whole tokens; echoes what you passed or the market default used")),
    start_receive: optional(text("whole tokens asked when the offer lands; pass it back when sending")),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    let opening: string | undefined;
    let floorShown: string | undefined;
    const result = await offered(ctx, call, input, async (sold, bought, now, inputMint, outputMint) => {
      const amountIn = raw(input.amount, sold.decimals, "amount");
      const fills = await recentFills(ctx.transport, inputMint, outputMint);
      const floor = input.min_receive === undefined ? marketFloor(fills, amountIn, input.max_slippage_bps) : raw(input.min_receive, bought.decimals, "min_receive");
      floorShown = formatAmount(floor, bought.decimals);
      const expiresIn = BigInt(input.expires_in ?? DEFAULT_EXPIRES_IN);
      const ask =
        input.exact === true
          ? floor
          : input.start_receive === undefined
            ? openingAsk(fills, amountIn, floor)
            : raw(input.start_receive, bought.decimals, "start_receive");
      if (ask <= floor) {
        return { order: { kind: "swap", amount_in: amountIn, min_out: floor }, expires_at: now + expiresIn + BigInt(LANDING_SECONDS) };
      }
      opening = formatAmount(ask, bought.decimals);
      const start = now + BigInt(LANDING_SECONDS);
      const falls = BigInt(input.falls_over ?? SWAP_FALLS_OVER);
      return {
        order: { kind: "dutch", amount_in: amountIn, start_out: ask, end_out: floor, start_time: start, end_time: start + falls },
        expires_at: start + (expiresIn > falls ? expiresIn : falls),
      };
    }, ORDER_DONE);
    return { ...result, ...(opening === undefined ? {} : { start_receive: opening }), ...(floorShown === undefined ? {} : { min_receive: floorShown }) };
  },
});

export const MAX_RECURRING = 12;

export const mayHaveLanded = (sent: number, times: number, problem: string) =>
  `${sent} of ${times} orders were sent and the next may have landed too (${problem}); check ${tool("wallet_intents")} before sending any again, and do not repeat this call`;

export const partlySent = (sent: number, times: number, problem: string) =>
  `${sent} of ${times} orders were sent; the next failed with ${problem}. To finish, schedule only the ${times - sent} remaining orders; do not repeat this call`;

export const WARN_EARLY = "an order fills before its turn if a solver can already pay its start_receive";

export const NO_FALL = "must be more than 0, or the orders have no ask to fall";

export const MAX_EVERY = 30 * 24 * 60 * 60;

export const walletRecurring = define({
  name: tool("wallet_recurring"),
  title: "Repeat a swap on a schedule",
  description: `Repeats a sale on a schedule: every order is sent now, each falling to min_receive. Leave min_receive out to accept the recent median less max_slippage_bps. To buy on a schedule, sell the other. Cancel any with ${tool("wallet_cancel")}. ${PREVIEW_FIRST} Pass back the preview's start_receive.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens each order sells, such as 0.05"),
    min_receive: optional(text("least whole tokens each order receives; default the recent median less max_slippage_bps")),
    max_slippage_bps: optional(integer(1, MAX_SLIPPAGE_BPS, "how far below the recent median the default min_receive sits, in basis points; default 100 = 1%")),
    every: integer(MIN_EXPIRES_IN, MAX_EVERY, "seconds between one order opening and the next"),
    times: integer(2, MAX_RECURRING, "how many orders"),
    start_receive: optional(text("whole tokens each order asks until and when it opens; default a little above the median recent fill, between 1.25 and 2 times min_receive")),
    falls_over: optional(integer(MIN_EXPIRES_IN, MAX_EVERY, `seconds each order's ask takes to fall to min_receive; default ${SWAP_FALLS_OVER}`)),
    pay_to: optional(account(PAY_TO)),
    send: optional(flag("true signs and sends every order; leave out to preview")),
  }),
  output: object({
    orders: list(
      object({ opens_at: time("when the order's ask starts to fall"), intent: optional(account()), nonce: optional(amount()), signature: optional(text()) }),
      MAX_RECURRING,
    ),
    summary: list(text(), 24, "the whole plan, then the first order"),
    warnings: list(text(), 16),
    start_receive: text("whole tokens each order asks when it opens; pass it back when sending"),
    min_receive: optional(text("the floor each order will not sell below, whole tokens; echoes what you passed or the market default used")),
    sent: flag(),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const inputMint = mintNamed(input.sell, wallet.url, "sell");
    const outputMint = mintNamed(input.buy, wallet.url, "buy");
    const [inputToken, outputToken, now] = await Promise.all([
      mintOf(ctx.transport, inputMint),
      mintOf(ctx.transport, outputMint),
      chainTime(ctx.transport),
    ]);
    const amountIn = raw(input.amount, inputToken.decimals, "amount");
    const fills = await recentFills(ctx.transport, inputMint, outputMint);
    const floor = input.min_receive === undefined ? marketFloor(fills, amountIn, input.max_slippage_bps) : raw(input.min_receive, outputToken.decimals, "min_receive");
    const ask = input.start_receive === undefined ? openingAsk(fills, amountIn, floor) : raw(input.start_receive, outputToken.decimals, "start_receive");
    if (ask <= floor) {
      throw new InvalidInput([
        input.start_receive === undefined ? { path: "min_receive", message: NO_FALL } : { path: "start_receive", message: "must be more than min_receive, or the order has no ask to fall" },
      ]);
    }
    const sales = await salesOf(wallet, now);
    checkSale(wallet.limits, inputMint, inputToken.decimals, amountIn, now, sales);
    checkHour(wallet.limits, inputMint, inputToken.decimals, amountIn * BigInt(input.times), now, sales);
    const falls = BigInt(input.falls_over ?? SWAP_FALLS_OVER);
    const every = BigInt(input.every);
    const life = falls > every ? falls : every;
    const opens = Array.from({ length: input.times }, (_, k) => now + BigInt(LANDING_SECONDS) + every * BigInt(k));
    const terms = (open: bigint) => () => ({
      order: { kind: "dutch" as const, amount_in: amountIn, start_out: ask, end_out: floor, start_time: open, end_time: open + falls },
      expires_at: open + life,
    });
    const shown = { start_receive: formatAmount(ask, outputToken.decimals), min_receive: formatAmount(floor, outputToken.decimals) };
    const last = opens[opens.length - 1] as bigint;
    const first = (await offered(ctx, call, { ...input, send: input.send }, terms(opens[0] as bigint))) as Record<string, unknown>;
    const sold = TOKEN_NAMES[inputMint] ?? inputMint;
    const plan = [
      `Plan: ${input.times} orders of ${formatAmount(amountIn, inputToken.decimals)} of ${sold}, ${formatAmount(amountIn * BigInt(input.times), inputToken.decimals)} of ${sold} in all, escrowed now`,
      `Schedule: the orders open from ${formatTime(opens[0] as bigint)} to ${formatTime(last)}; the last expires ${formatTime(last + life)}`,
      ...(first["summary"] as string[]),
    ];
    const warned = first["warnings"] as string[];
    const warnings = [
      ...warned,
      WARN_EARLY,
      ...(last + life - now > LONG_LIVED_SECONDS && !warned.includes(WARN_LONG_LIVED) ? [WARN_LONG_LIVED] : []),
    ];
    if (input.send !== true) {
      return { orders: opens.map((opens_at) => ({ opens_at })), summary: plan, warnings, ...shown, sent: false, next: first["next"] };
    }
    const orders = [{ opens_at: opens[0] as bigint, intent: first["intent"], nonce: first["nonce"], signature: first["signature"] }];
    for (const open of opens.slice(1)) {
      try {
        const made = (await offered(ctx, call, { ...input, send: true }, terms(open))) as Record<string, unknown>;
        orders.push({ opens_at: open, intent: made["intent"], nonce: made["nonce"], signature: made["signature"] });
      } catch (error) {
        for (const undo of call.undo.splice(0)) {
          undo();
        }
        const problem = problemOf(error);
        return {
          orders: [...orders, ...opens.slice(orders.length).map((opens_at) => ({ opens_at }))],
          summary: plan,
          warnings,
          ...shown,
          sent: true,
          next: refusedBeforeSending(error)
            ? partlySent(orders.length, input.times, `${problem.code}: ${problem.hint}`)
            : mayHaveLanded(orders.length, input.times, `${problem.code}: ${problem.hint}`),
        };
      }
    }
    return {
      orders,
      summary: plan,
      warnings,
      ...shown,
      sent: true,
      next: `all ${input.times} orders are escrowed; call ${tool("wallet_intents")} to see them, or ${tool("wallet_wait")} on each nonce as it opens`,
    };
  },
});

export const walletAuction = define({
  name: tool("wallet_auction"),
  title: "Auction from the wallet",
  description: `Sells an exact amount in a falling-price (Dutch) auction you design: the ask starts at start_receive, falls evenly to end_receive over falls_over seconds, then holds until it expires. A solver fills when the ask meets what it can pay. For a simple market sell, use ${tool("wallet_swap")}. ${PREVIEW_FIRST}`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    start_receive: text("whole tokens asked when the auction starts; more than end_receive"),
    end_receive: text("least whole tokens accepted once the asked amount stops falling"),
    falls_over: integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "seconds the asked amount takes to fall from start_receive to end_receive"),
    expires_in: optional(
      integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the offer stays open once sent, never less than falls_over; default ${DEFAULT_EXPIRES_IN}`),
    ),
    pay_to: optional(account(PAY_TO)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: offerOutput,
  run: async (ctx: AgentContext, input, call: Call) =>
    offered(ctx, call, input, (sold, bought, now) => {
      const start = now + BigInt(LANDING_SECONDS);
      const startOut = raw(input.start_receive, bought.decimals, "start_receive");
      const endOut = raw(input.end_receive, bought.decimals, "end_receive");
      if (startOut <= endOut) {
        throw new InvalidInput([{ path: "start_receive", message: `must be more than end_receive, or the ask does not fall; for a fixed price use ${tool("wallet_swap")}` }]);
      }
      return {
        order: {
          kind: "dutch",
          amount_in: raw(input.amount, sold.decimals, "amount"),
          start_out: startOut,
          end_out: endOut,
          start_time: start,
          end_time: start + BigInt(input.falls_over),
        },
        expires_at: start + BigInt(Math.max(input.expires_in ?? DEFAULT_EXPIRES_IN, input.falls_over)),
      };
    }, ORDER_DONE),
});

export const ESTIMATE_NEXT =
  "solvers pay the least an intent asks, so these fills show what owners asked and got, not the most a solver would pay; ask a minimum near receive_at_median, since a single fill can be staged by one party on both sides, or auction from a little above it down to the least the user accepts to find the price";

export const NO_FILLS = `no recent fill sold this token for that one; auction from a high ask down to the least the user accepts with ${tool("wallet_auction")} to find the price`;

export const walletEstimate = define({
  name: tool("wallet_estimate"),
  title: "Estimate a swap from recent fills",
  description: `Tells the user what selling an amount of one token for another would get now, from recent fills of the same pair on this network. It reads the engine's last ${ESTIMATE_SCAN} transactions and sends nothing. Use it before ${tool("wallet_swap")} or ${tool("wallet_auction")} to pick min_receive or the auction's start and end.`,
  effect: "read",
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
  }),
  output: object({
    fills: list(
      object({
        sold: text("whole tokens of the sold token"),
        received: text("whole tokens the owner received"),
        at: optional(time("when the fill landed")),
        signature: text(),
      }),
      ESTIMATE_FILLS,
      "newest first",
    ),
    receive_at_best: optional(text("whole tokens amount would get at the best recent rate; one fill can be staged by its own two sides")),
    receive_at_median: optional(text("whole tokens amount would get at the median recent rate")),
    receive_at_latest: optional(text("whole tokens amount would get at the newest fill's rate")),
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = await testCluster(ctx);
    const inputMint = mintNamed(input.sell, wallet.url, "sell");
    const outputMint = mintNamed(input.buy, wallet.url, "buy");
    const [inputToken, outputToken] = await Promise.all([mintOf(ctx.transport, inputMint), mintOf(ctx.transport, outputMint)]);
    const amount = raw(input.amount, inputToken.decimals, "amount");
    const matching = await recentFills(ctx.transport, inputMint, outputMint);
    const shown = matching.map((f) => ({
      sold: formatAmount(f.amountIn, inputToken.decimals),
      received: formatAmount(f.delivered, outputToken.decimals),
      ...(f.blockTime === null ? {} : { at: f.blockTime }),
      signature: f.signature,
    }));
    const [latest] = matching;
    if (latest === undefined) {
      return { fills: shown, next: NO_FILLS };
    }
    const best = bestOf(matching) ?? latest;
    const at = (f: Fill) => formatAmount((amount * f.delivered) / f.amountIn, outputToken.decimals);
    return { fills: shown, receive_at_best: at(best), receive_at_median: at(medianOf(matching) ?? latest), receive_at_latest: at(latest), next: ESTIMATE_NEXT };
  },
});
