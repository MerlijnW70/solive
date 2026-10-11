import type { Address, KeyPairSigner } from "@solana/kit";
import { decodeEvent, findIntentPda, formatAmount, getIntentDecoder, IntentStatus, parseAmount } from "@intent-engine/core";
import { chainTime, CLOCK_SYSVAR, mintOf } from "../accounts.js";
import { ENV_KEYPAIR, type Env, WALLET_NOT_MAINNET, type WalletLimits } from "../args.js";
import { execute, type PreparedView } from "../flows.js";
import { TOKEN_NAMES, tokenNamed } from "../tokens.js";
import { neverLanded, type Transport, unmemoized } from "../transport.js";
import { balances, defaultMints, FAUCET, type Files, PUBLIC_FAUCET, setup, withSettings } from "../wallet.js";
import { type AgentContext, type AnyAction, define } from "./actions.js";
import type { Call } from "./claims.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN, prepareCreate } from "./create.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import { listIntents } from "./read.js";
import { InvalidInput, account, amount, choice, flag, integer, list, object, optional, type Schema, text, time } from "./schema.js";
import { orderSchema } from "./shapes.js";
import { prepareCancel } from "./settle.js";
import { STATUS } from "../accounts.js";

type Sale = { mint: Address; at: bigint; amount: bigint };

export type WalletGuard = { limits: WalletLimits; sales: Sale[] };

export const walletGuard = (limits: WalletLimits): WalletGuard => ({ limits, sales: [] });

export type WalletAccess = {
  url: string;
  files: Files;
  env: Env;
  sleep(seconds: number): Promise<boolean>;
  now(): bigint;
  limits: WalletGuard;
};

export const SALE_WINDOW = 3_600n;
export const ESTIMATE_SCAN = 12;
export const ESTIMATE_FILLS = 5;
export const WAIT_DEFAULT = 30;
export const WAIT_MAX = 40;
export const WAIT_SCAN = 10;

export const DEFAULT_EXPIRES_IN = 3_600;
export const LANDING_SECONDS = 10;

export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const WALLET_NOTICE = [
  "Test network only: this wallet works on Solana devnet, testnet or localnet and refuses mainnet. Its tokens have no value.",
  "Your key stays on this machine: setup makes one unless a keypair is already configured, and names its file. Only signed transactions leave it.",
  "This server talks to no one but the RPC endpoint it was started with.",
  "Nothing moves until you approve: swaps, auctions and cancels only preview until you say yes.",
  "Do not send real funds to this wallet or use its key anywhere else.",
];

export const walletEmpty = (address: string) =>
  `the wallet ${address} holds no SOL yet; request devnet SOL for it at ${FAUCET} or ${PUBLIC_FAUCET}, then try again`;

export const NO_WALLET = `this server has no wallet yet; call ${tool("wallet_setup")} first`;
export const WALLET_OFF = "this server runs without a wallet; start it with mcp --wallet to let it sign";
export const PREVIEW_ONLY =
  "nothing was sent; show the summary to the user and call again with send: true only after they approve";

function access(ctx: AgentContext): WalletAccess {
  if (ctx.wallet === undefined) {
    throw new AgentRefusal("WalletNotConfigured", WALLET_OFF);
  }
  return ctx.wallet;
}

const genesisOf = new WeakMap<WalletAccess, Promise<string>>();

async function testCluster(ctx: AgentContext): Promise<WalletAccess> {
  const wallet = access(ctx);
  let genesis = genesisOf.get(wallet);
  if (genesis === undefined) {
    const read = ctx.transport.genesisHash();
    genesis = read;
    genesisOf.set(wallet, read);
    read.catch(() => {
      if (genesisOf.get(wallet) === read) {
        genesisOf.delete(wallet);
      }
    });
  }
  if ((await genesis) === MAINNET_GENESIS) {
    throw new AgentRefusal("WalletNotMainnet", WALLET_NOT_MAINNET);
  }
  return wallet;
}

async function savedKeypair(wallet: WalletAccess): Promise<string | undefined> {
  return (await withSettings(wallet.files, wallet.env))[ENV_KEYPAIR];
}

async function signerOf(ctx: AgentContext): Promise<KeyPairSigner> {
  const wallet = await testCluster(ctx);
  const path = await savedKeypair(wallet);
  if (path === undefined) {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
  try {
    return await wallet.files.loadSigner(path);
  } catch {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
}

function mintNamed(text: string, url: string, path: string): Address {
  const mint = tokenNamed(text.trim(), url);
  if (mint instanceof Error) {
    throw new InvalidInput([{ path, message: mint.message }]);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new InvalidInput([{ path, message: "name SOL, TEST or a token mint address" }]);
  }
  return mint as Address;
}

function raw(tokens: string, decimals: number, path: string): bigint {
  try {
    return parseAmount(tokens, decimals);
  } catch (error) {
    throw new InvalidInput([{ path, message: error instanceof Error ? error.message : String(error) }]);
  }
}

const nameOf = (mint: Address): string => TOKEN_NAMES[mint] ?? mint;

const limited = (guard: WalletGuard): boolean => guard.limits.perTrade.size + guard.limits.perHour.size > 0;

export function limitLines(limits: WalletLimits): string[] {
  const mints = [...new Set([...limits.perTrade.keys(), ...limits.perHour.keys()])];
  if (mints.length === 0) {
    return [];
  }
  return [
    "Whoever started this server set sell limits that no tool call can change:",
    ...mints.map((mint) => {
      const caps = [
        ...(limits.perTrade.has(mint) ? [`${limits.perTrade.get(mint)} per trade`] : []),
        ...(limits.perHour.has(mint) ? [`${limits.perHour.get(mint)} per hour`] : []),
      ];
      return `- ${nameOf(mint)}: at most ${caps.join(" and ")}`;
    }),
    "It sells no other token. Plan trades within these limits and tell the user when a request exceeds them.",
  ];
}

function capOf(text: string, decimals: number, mint: Address): bigint {
  try {
    return parseAmount(text, decimals);
  } catch {
    throw new AgentRefusal(
      "WalletTokenNotAllowed",
      `this server's limit of ${text} ${nameOf(mint)} does not fit a token with ${decimals} decimals, so it sells none; the user restarts it with a valid limit`,
    );
  }
}

function checkSale(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint): void {
  if (!limited(guard)) {
    return;
  }
  const { perTrade, perHour } = guard.limits;
  const name = nameOf(mint);
  if (!perTrade.has(mint) && !perHour.has(mint)) {
    const allowed = [...new Set([...perTrade.keys(), ...perHour.keys()])].map(nameOf).join(", ");
    throw new AgentRefusal("WalletTokenNotAllowed", `this server sells only ${allowed}, not ${name}; its limits were set when it started`);
  }
  const trade = perTrade.get(mint);
  if (trade !== undefined && amount > capOf(trade, decimals, mint)) {
    throw new AgentRefusal(
      "WalletTradeLimit",
      `this server sells at most ${trade} ${name} per trade and this sells ${formatAmount(amount, decimals)}; sell less, or the user restarts the server with a higher --wallet-per-trade`,
    );
  }
  const hour = perHour.get(mint);
  if (hour === undefined) {
    return;
  }
  guard.sales = guard.sales.filter((s) => s.at > now - SALE_WINDOW);
  const used = guard.sales.filter((s) => s.mint === mint).reduce((sum, s) => sum + s.amount, 0n);
  const cap = capOf(hour, decimals, mint);
  if (used + amount > cap) {
    throw new AgentRefusal(
      "WalletHourLimit",
      `this server sells at most ${hour} ${name} per hour and has ${formatAmount(cap > used ? cap - used : 0n, decimals)} left; this sells ${formatAmount(amount, decimals)}`,
    );
  }
}

async function sent(ctx: AgentContext, signer: KeyPairSigner, view: Record<string, unknown>, send: boolean | undefined, call: Call) {
  for (const undo of call.undo.splice(0)) {
    undo();
  }
  const { prepared, ...shown } = view as { prepared: PreparedView } & Record<string, unknown>;
  if (send !== true) {
    return { ...shown, sent: false, next: PREVIEW_ONLY };
  }
  if ((await ctx.transport.genesisHash()) === MAINNET_GENESIS) {
    throw new AgentRefusal("WalletNotMainnet", WALLET_NOT_MAINNET);
  }
  return { ...shown, sent: true, signature: await execute(ctx.transport, prepared, signer) };
}

const tokenRow = object({
  mint: account(),
  name: optional(text()),
  account: account("the wallet's token account for this mint"),
  balance: text("in whole tokens"),
});

const walletSetup = define({
  name: tool("wallet_setup"),
  title: "Set up the wallet",
  description:
    "Create this server's devnet wallet if it has none, save it, and fund it from the devnet airdrop when it holds less than 0.5 SOL. Safe to call again: it reuses the saved wallet. Call this first.",
  effect: "submit",
  input: object({}),
  output: object({
    address: account(),
    keypair: text("the file holding the wallet's key on this machine"),
    created: flag("true when this call made the wallet"),
    url: text(),
    sol: text("SOL the wallet holds"),
    next: text("what to tell the user"),
    notice: list(text(), 8, "the notice from the server instructions; show it if the user has not seen it yet"),
  }),
  run: async (ctx: AgentContext) => {
    const wallet = await testCluster(ctx);
    return { ...(await setup(ctx.transport, wallet.files, wallet.url, await savedKeypair(wallet))), notice: WALLET_NOTICE };
  },
});

export const walletBalance = define({
  name: tool("wallet_balance"),
  title: "Show the wallet's balances",
  description: "Show the SOL and token balances of this server's wallet, in whole tokens. Without mints it shows wrapped SOL and, on devnet, the TEST token.",
  effect: "read",
  input: object({ mints: optional(list(text("SOL, TEST or a mint address"), 8)) }),
  output: object({ address: account(), sol: text(), tokens: list(tokenRow, 8) }),
  run: async (ctx: AgentContext, input) => {
    const wallet = access(ctx);
    const owner = (await signerOf(ctx)).address;
    const mints = input.mints?.map((m, i) => mintNamed(m, wallet.url, `mints.${i}`)) ?? defaultMints(wallet.url);
    return balances(ctx.transport, owner, mints);
  },
});

const offerFields = {
  intent: account(),
  nonce: amount(),
  summary: list(text(), 24),
  warnings: list(text(), 16),
  sent: flag(),
  signature: optional(text()),
  next: optional(text()),
};

const offerOutput = object(offerFields);

type Token = Awaited<ReturnType<typeof mintOf>>;

type Order = typeof orderSchema extends Schema<infer T> ? T : never;

async function offered(
  ctx: AgentContext,
  call: Call,
  input: { sell: string; buy: string; send?: boolean | undefined },
  terms: (sold: Token, bought: Token, now: bigint, inputMint: Address, outputMint: Address) => Promise<{ order: Order; expires_at: bigint }> | { order: Order; expires_at: bigint },
) {
  const wallet = access(ctx);
  const signer = await signerOf(ctx);
  const inputMint = mintNamed(input.sell, wallet.url, "sell");
  const outputMint = mintNamed(input.buy, wallet.url, "buy");
  await ctx.transport.warm?.([signer.address, inputMint, outputMint, CLOCK_SYSVAR]);
  if (((await ctx.transport.getAccount(signer.address))?.lamports ?? 0n) === 0n) {
    throw new AgentRefusal("WalletEmpty", walletEmpty(signer.address));
  }
  const [inputToken, outputToken, now] = await Promise.all([
    mintOf(ctx.transport, inputMint),
    mintOf(ctx.transport, outputMint),
    chainTime(ctx.transport),
  ]);
  const made = await terms(inputToken, outputToken, now, inputMint, outputMint);
  checkSale(wallet.limits, inputMint, inputToken.decimals, (made.order as { amount_in: bigint }).amount_in, now);
  const view = (await prepareCreate.run(
    ctx,
    { owner: signer.address, input_mint: inputMint, output_mint: outputMint, ...made } as never,
    call,
  )) as Record<string, unknown>;
  const { intent, nonce, summary, warnings, prepared } = view;
  const sold = (made.order as { amount_in: bigint }).amount_in;
  const guard = wallet.limits;
  checkSale(guard, inputMint, inputToken.decimals, sold, now);
  if (input.send !== true || !limited(guard)) {
    return sent(ctx, signer, { intent, nonce, summary, warnings, prepared }, input.send, call);
  }
  const sale = { mint: inputMint, at: now, amount: sold };
  guard.sales.push(sale);
  try {
    return await sent(ctx, signer, { intent, nonce, summary, warnings, prepared }, input.send, call);
  } catch (error) {
    if (neverLanded(error)) {
      guard.sales = guard.sales.filter((s) => s !== sale);
    }
    throw error;
  }
}

export const SWAP_FALLS_OVER = 120;
export const SWAP_HEADROOM_BPS = 200n;
export const SWAP_BLIND_BPS = 2_500n;

async function recentFills(transport: Transport, inputMint: Address, outputMint: Address): Promise<Fill[]> {
  const { created, fills } = await engineHistory(transport, ESTIMATE_SCAN);
  const unknown = [...new Set(fills.map((f) => f.intent).filter((intent) => !created.has(intent)))];
  const views = unknown.length === 0 ? [] : await transport.getAccounts(unknown);
  unknown.forEach((intent, i) => {
    const view = views[i];
    const pair = view === null || view === undefined ? null : pairOf(view.data);
    if (pair !== null) {
      created.set(intent, pair);
    }
  });
  return fills
    .filter((f) => f.amountIn > 0n && created.get(f.intent)?.inputMint === inputMint && created.get(f.intent)?.outputMint === outputMint)
    .slice(0, ESTIMATE_FILLS);
}

const bestOf = (fills: Fill[]): Fill | undefined =>
  fills.reduce<Fill | undefined>((a, b) => (a === undefined || b.delivered * a.amountIn > a.delivered * b.amountIn ? b : a), undefined);

function openingAsk(fills: Fill[], amount: bigint, floor: bigint): bigint {
  const best = bestOf(fills);
  const ask = best === undefined ? (floor * (10_000n + SWAP_BLIND_BPS)) / 10_000n : (amount * best.delivered * (10_000n + SWAP_HEADROOM_BPS)) / (best.amountIn * 10_000n);
  return ask > floor ? ask : floor;
}

const walletSwap = define({
  name: tool("wallet_swap"),
  title: "Swap from the wallet",
  description: `Sell an exact amount of one token for at least min_receive of another, from this server's wallet: the tokens are escrowed in an intent that a solver fills or that the wallet gets back. Solvers pay the least an intent asks, so by default the ask starts at start_receive, a little above the best recent fill, and falls to min_receive over falls_over seconds (default ${SWAP_FALLS_OVER}): a solver takes it near the most it can pay. exact: true asks min_receive from the start instead. Amounts are whole tokens such as 0.05. Selling SOL wraps it first. Without send it only previews; show the user the summary, then call again with send: true and the start_receive the preview returned once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    min_receive: text("least whole tokens to receive for all of it"),
    start_receive: optional(text("whole tokens asked when the offer lands; default a little above the best recent fill")),
    falls_over: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `seconds the ask takes to fall to min_receive; default ${SWAP_FALLS_OVER}`)),
    exact: optional(flag("true asks min_receive from the start, with no falling ask")),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the offer stays open once sent; default ${DEFAULT_EXPIRES_IN}`)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({ ...offerFields, start_receive: optional(text("whole tokens asked when the offer lands; pass it back when sending")) }),
  run: async (ctx: AgentContext, input, call: Call) => {
    let opening: string | undefined;
    const result = await offered(ctx, call, input, async (sold, bought, now, inputMint, outputMint) => {
      const amountIn = raw(input.amount, sold.decimals, "amount");
      const floor = raw(input.min_receive, bought.decimals, "min_receive");
      const expiresIn = BigInt(input.expires_in ?? DEFAULT_EXPIRES_IN);
      const ask =
        input.exact === true
          ? floor
          : input.start_receive === undefined
            ? openingAsk(await recentFills(ctx.transport, inputMint, outputMint), amountIn, floor)
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
    });
    return opening === undefined ? result : { ...result, start_receive: opening };
  },
});

const walletAuction = define({
  name: tool("wallet_auction"),
  title: "Auction from the wallet",
  description:
    "Offer an exact amount of one token in a Dutch auction from this server's wallet: the least it accepts starts at start_receive once the offer lands, falls in a straight line to end_receive over falls_over seconds, then stays there until it expires, so a solver fills it as soon as the asked amount meets what it can pay. Amounts are whole tokens such as 0.05. Selling SOL wraps it first. Without send it only previews; show the user the summary and call again with send: true once they approve.",
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    start_receive: text("whole tokens asked when the auction starts; at least end_receive"),
    end_receive: text("least whole tokens accepted once the asked amount stops falling"),
    falls_over: integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "seconds the asked amount takes to fall from start_receive to end_receive"),
    expires_in: optional(
      integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the offer stays open once sent, never less than falls_over; default ${DEFAULT_EXPIRES_IN}`),
    ),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: offerOutput,
  run: async (ctx: AgentContext, input, call: Call) =>
    offered(ctx, call, input, (sold, bought, now) => {
      const start = now + BigInt(LANDING_SECONDS);
      return {
        order: {
          kind: "dutch",
          amount_in: raw(input.amount, sold.decimals, "amount"),
          start_out: raw(input.start_receive, bought.decimals, "start_receive"),
          end_out: raw(input.end_receive, bought.decimals, "end_receive"),
          start_time: start,
          end_time: start + BigInt(input.falls_over),
        },
        expires_at: start + BigInt(Math.max(input.expires_in ?? DEFAULT_EXPIRES_IN, input.falls_over)),
      };
    }),
});

const walletIntents = define({
  name: tool("wallet_intents"),
  title: "List the wallet's intents",
  description: "List the intents this server's wallet created, newest state first: open ones can still fill or be cancelled.",
  effect: "read",
  input: object({ status: optional(choice(STATUS, "only intents in this status")) }),
  output: listIntents.output,
  run: async (ctx: AgentContext, input, call: Call) => {
    const owner = (await signerOf(ctx)).address;
    return listIntents.run(ctx, { owner, ...(input.status === undefined ? {} : { status: input.status }) } as never, call);
  },
});

const walletCancel = define({
  name: tool("wallet_cancel"),
  title: "Cancel a wallet intent",
  description:
    "Cancel an open intent of this server's wallet by its nonce: the escrow returns to the wallet and the intent account closes, returning its rent. Without send it only previews; call again with send: true once the user approves.",
  effect: "submit",
  input: object({ nonce: amount("the intent's nonce, from wallet_intents"), send: optional(flag("true signs and sends; leave out to preview")) }),
  output: object({
    intent: account(),
    refund: amount("raw input units returned to the wallet"),
    summary: list(text(), 16),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const view = (await prepareCancel.run(ctx, { owner: signer.address, nonce: input.nonce, close: true } as never, call)) as Record<
      string,
      unknown
    >;
    return sent(ctx, signer, view, input.send, call);
  },
});

type Fill = { intent: Address; amountIn: bigint; delivered: bigint; signature: string; blockTime: bigint | null };

type Pair = { inputMint: Address; outputMint: Address };

async function engineHistory(transport: Transport, limit: number, of?: Address) {
  const created = new Map<Address, Pair>();
  const fills: Fill[] = [];
  const ended = new Map<Address, "cancelled" | "expired">();
  for (const tx of await transport.engineTransactions(limit, of)) {
    if (tx.failed) {
      continue;
    }
    const begun = new Map<Address, bigint>();
    for (const event of tx.emitted.map(decodeEvent)) {
      if (event === null) {
        continue;
      }
      const fields = event.fields as Record<string, unknown>;
      const intent = fields["intent"] as Address;
      if (event.name === "IntentCreated") {
        created.set(intent, { inputMint: fields["inputMint"] as Address, outputMint: fields["outputMint"] as Address });
      }
      if (event.name === "FillBegun") {
        begun.set(intent, fields["amountIn"] as bigint);
      }
      const amountIn = event.name === "IntentFilled" ? (fields["amountIn"] as bigint) : event.name === "FillEnded" ? begun.get(intent) : undefined;
      if (amountIn !== undefined) {
        fills.push({ intent, amountIn, delivered: fields["delivered"] as bigint, signature: tx.signature, blockTime: tx.blockTime });
      }
      if (event.name === "IntentCancelled" || event.name === "IntentExpired") {
        ended.set(intent, event.name === "IntentCancelled" ? "cancelled" : "expired");
      }
    }
  }
  return { created, fills, ended };
}

function pairOf(data: Uint8Array): Pair | null {
  try {
    const { inputMint, outputMint } = getIntentDecoder().decode(data);
    return { inputMint, outputMint };
  } catch {
    return null;
  }
}

export const ESTIMATE_NEXT =
  "solvers pay the least an intent asks, so these fills show what owners asked and got, not the most a solver would pay; ask a minimum near receive_at_best, or auction from a little above it down to the least the user accepts to find the price";

export const NO_FILLS = `no recent fill sold this token for that one; auction from a high ask down to the least the user accepts with ${tool("wallet_auction")} to find the price`;

const walletEstimate = define({
  name: tool("wallet_estimate"),
  title: "Estimate a swap from recent fills",
  description: `Estimate what selling an amount of one token for another gets now, from the rates of recent fills of the same pair on this cluster. It reads the engine's last ${ESTIMATE_SCAN} transactions and sends nothing. Use it before ${tool("wallet_swap")} or ${tool("wallet_auction")} to pick min_receive or the auction's start and end.`,
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
    receive_at_best: optional(text("whole tokens amount would get at the best recent rate")),
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
    return { fills: shown, receive_at_best: at(best), receive_at_latest: at(latest), next: ESTIMATE_NEXT };
  },
});

export const WAIT_STATUS = ["open", "filling", "filled", "cancelled", "expired", "closed"] as const;

type WaitStatus = (typeof WAIT_STATUS)[number];

export const stillWaiting = (status: string) =>
  `still ${status}; call ${tool("wallet_wait")} again to keep waiting, or ${tool("wallet_cancel")} to take the escrow back`;

const walletWait = define({
  name: tool("wallet_wait"),
  title: "Wait for a wallet intent",
  description: `Wait until an intent of this server's wallet is filled, cancelled or expired, or until within seconds pass, then say which and, for a fill, how much the wallet received. Use it after sending instead of asking the user to check again; call it again while the status is still open.`,
  effect: "read",
  input: object({
    nonce: amount("the intent's nonce, from the send or wallet_intents"),
    within: optional(integer(1, WAIT_MAX, `most seconds to wait; default ${WAIT_DEFAULT}`)),
  }),
  output: object({
    intent: account(),
    status: choice(WAIT_STATUS, "closed means the account is gone and its recent transactions name no fill, cancel or expiry"),
    waited: integer(0, WAIT_MAX, "seconds waited"),
    received: optional(text("whole tokens the wallet received from fills")),
    token: optional(text("the token received")),
    signature: optional(text("the fill's transaction")),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input) => {
    const wallet = access(ctx);
    const owner = (await signerOf(ctx)).address;
    const [intent] = await findIntentPda({ owner, nonce: input.nonce });
    const within = input.within ?? WAIT_DEFAULT;
    const fresh = unmemoized(ctx.transport);
    const deadline = wallet.now() + BigInt(within);
    let waited = 0;
    let pair: Pair | null = null;
    let status: WaitStatus = "closed";
    for (;;) {
      const view = await fresh.getAccount(intent);
      if (view === null) {
        status = "closed";
        break;
      }
      const decoded = getIntentDecoder().decode(view.data);
      pair = { inputMint: decoded.inputMint, outputMint: decoded.outputMint };
      status = STATUS[decoded.status] ?? "open";
      if ((status !== "open" && status !== "filling") || waited >= within || wallet.now() >= deadline || !(await wallet.sleep(1))) {
        break;
      }
      waited += 1;
    }
    if (status === "open" || status === "filling") {
      return { intent, status, waited, next: stillWaiting(status) };
    }
    if (status === "cancelled" || status === "expired") {
      return { intent, status, waited };
    }
    const history = await engineHistory(ctx.transport, WAIT_SCAN, intent);
    const fills = history.fills.filter((f) => f.intent === intent);
    if (fills.length === 0) {
      return { intent, status: status === "closed" ? (history.ended.get(intent) ?? status) : status, waited };
    }
    pair ??= history.created.get(intent) ?? null;
    const decimals = pair === null ? undefined : (await mintOf(ctx.transport, pair.outputMint)).decimals;
    return {
      intent,
      status: "filled",
      waited,
      received: formatAmount(fills.reduce((sum, f) => sum + f.delivered, 0n), decimals),
      ...(pair === null ? {} : { token: nameOf(pair.outputMint) }),
      signature: fills[0]?.signature,
    };
  },
});

export const WALLET_ACTIONS: readonly AnyAction[] = [
  walletSetup,
  walletBalance,
  walletEstimate,
  walletSwap,
  walletAuction,
  walletWait,
  walletIntents,
  walletCancel,
];
