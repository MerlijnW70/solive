import type { Address, KeyPairSigner } from "@solana/kit";
import {
  attestedFillMessage,
  buildFillAttested,
  decodeEvent,
  decodeParams,
  feeBpsFor,
  findIntentPda,
  formatAmount,
  getIntentDecoder,
  IntentStatus,
  Kind,
  parseAmount,
  signEd25519Instruction,
  splitFees,
  WARN_ATTESTOR,
} from "@intent-engine/core";
import { chainTime, CLOCK_SYSVAR, loadConfig, mintOf } from "../accounts.js";
import { ENV_KEYPAIR, type Env, WALLET_NOT_MAINNET, type WalletLimits } from "../args.js";
import { execute, type PreparedView } from "../flows.js";
import { NATIVE_MINT, TOKEN_NAMES, tokenNamed } from "../tokens.js";
import { neverLanded, type Transport, unmemoized } from "../transport.js";
import { balances, defaultMints, FAUCET, type Files, PUBLIC_FAUCET, setup, withSettings } from "../wallet.js";
import { type AgentContext, type AnyAction, define } from "./actions.js";
import type { Call } from "./claims.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN, prepareCreate } from "./create.js";
import { tool } from "./names.js";
import { AgentRefusal, problemOf } from "./problems.js";
import { listIntents } from "./read.js";
import { InvalidInput, account, amount, choice, flag, integer, list, object, optional, type Schema, text, time } from "./schema.js";
import { orderSchema, preparedView } from "./shapes.js";
import { tokenAccountIfMissing } from "./owner.js";
import { prepare } from "./prepare.js";
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
  "Nothing moves until you approve: swaps, auctions, escrows, releases and cancels only preview until you say yes.",
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
  checkHour(guard, mint, decimals, amount, now);
}

function checkHour(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint): void {
  const hour = guard.limits.perHour.get(mint);
  const name = nameOf(mint);
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
  input: { sell: string; buy: string; pay_to?: Address | undefined; send?: boolean | undefined },
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
    { owner: signer.address, input_mint: inputMint, output_mint: outputMint, ...(input.pay_to === undefined ? {} : { pay_to: input.pay_to }), ...made } as never,
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
export const PAY_TO = "the wallet that receives what is bought, such as someone this wallet pays; default this wallet. This wallet pays for its token account if it has none";
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
    pay_to: optional(account(PAY_TO)),
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

export const ESCROW_EXPIRES_IN = 86_400;

function recordedMint(sell: Address, url: string): Address {
  return sell === NATIVE_MINT ? mintNamed("TEST", url, "sell") : NATIVE_MINT;
}

const walletEscrow = define({
  name: tool("wallet_escrow"),
  title: "Escrow a payment for an attestor to release",
  description: `Lock an exact amount of one token from this server's wallet in an attested intent: it goes, minus the engine fee, to whichever wallet the named attestor later signs for, once the attestor attests a result between min_result and max_result. Use it to pay another agent for work that a third agent or a person judges. The attestor alone decides who is paid; nothing else is checked on chain, so name an attestor the user trusts. Until then the wallet can cancel it with ${tool("wallet_cancel")}, and after it expires anyone can return the escrow. Amounts are whole tokens such as 0.05. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    amount: text("whole tokens to escrow, such as 0.05"),
    attestor: account("the wallet whose signature alone releases the escrow"),
    min_result: optional(amount("least result the attestor may attest; default 1")),
    max_result: optional(amount("greatest result the attestor may attest; default min_result")),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: offerOutput,
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const least = input.min_result ?? 1n;
    const most = input.max_result ?? least;
    if (most < least) {
      throw new InvalidInput([{ path: "max_result", message: "must be at least min_result" }]);
    }
    return offered(ctx, call, { sell: sold, buy: recordedMint(sold, wallet.url), send: input.send }, (token, _, now) => ({
      order: { kind: "attested", amount_in: raw(input.amount, token.decimals, "amount"), min_result: least, max_result: most, attestor: input.attestor },
      expires_at: now + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
    }));
  },
});

export const notAttestor = (attestor: string) =>
  `this intent names ${attestor} as its attestor, not this server's wallet; only that key can release it`;

const walletAttest = define({
  name: tool("wallet_attest"),
  title: "Release an escrow as its attestor",
  description: `As the attestor an escrow names, sign that it pays pay_to and settle it on chain from this server's wallet: the escrowed tokens, minus the engine fee, go to pay_to's token account, which this creates if needed. Use it when this server's wallet was named attestor of an intent made with ${tool("wallet_escrow")} and the work it pays for is done. Without send it only previews and signs nothing; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    pay_to: account("the wallet to pay"),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    pay_to: account(),
    payee: account("pay_to's token account that receives the escrow"),
    paid: text("whole tokens pay_to receives"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
    const [view, { config }] = await Promise.all([ctx.transport.getAccount(intent), loadConfig(ctx.transport)]);
    if (view === null) {
      throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled, cancelled and closed, or never made`);
    }
    const held = getIntentDecoder().decode(view.data);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind !== Kind.AttestedResult) {
      throw new AgentRefusal("KindMismatch", "this intent is not an attested escrow");
    }
    if (params.attestor !== signer.address) {
      throw new AgentRefusal("Unauthorized", notAttestor(params.attestor));
    }
    if (held.status !== IntentStatus.Open) {
      throw new AgentRefusal("InvalidTransition", `this escrow is ${STATUS[held.status] ?? "not open"}, so it can no longer be released`);
    }
    if (held.expiresAt <= (await chainTime(ctx.transport))) {
      throw new AgentRefusal("IntentExpired", "this escrow has expired; its owner gets it back instead");
    }
    const result = input.result ?? params.minResult;
    if (result < params.minResult || result > params.maxResult) {
      throw new InvalidInput([{ path: "result", message: `must be between ${params.minResult} and ${params.maxResult}` }]);
    }
    const token = await mintOf(ctx.transport, held.inputMint);
    const payee = await tokenAccountIfMissing(ctx.transport, signer, input.pay_to, held.inputMint, token.tokenProgram);
    const amountIn = held.escrowed - held.filled;
    const maxFeeBps = feeBpsFor(config, held.kind) + held.partnerBps;
    const shares = splitFees(amountIn, feeBpsFor(config, held.kind), held.partnerBps, config.partnerCutBps);
    const treasury =
      shares.protocol > 0n
        ? await tokenAccountIfMissing(ctx.transport, signer, config.feeRecipient, held.inputMint, token.tokenProgram)
        : { create: [] };
    const message = await attestedFillMessage(signer.address, {
      domain: Uint8Array.from(config.domain),
      intent,
      payee: payee.address,
      amountIn,
      result,
      filled: held.filled,
      revision: held.revision,
      maxFeeBps,
    });
    const settle = await buildFillAttested({
      solver: signer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      payee: payee.address,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(held.partnerBps === 0 ? {} : { partner: held.partner }),
      amountIn,
      result,
      maxFeeBps,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const paid = formatAmount(shares.net, token.decimals);
    const prepared = preparedView(
      await prepare(ctx.transport, [...payee.create, ...treasury.create, await signEd25519Instruction(signer, message), settle], signer.address),
    );
    const view2 = {
      intent,
      pay_to: input.pay_to,
      payee: payee.address,
      paid,
      fee: formatAmount(shares.protocol + shares.partner, token.decimals),
      result,
      summary: [
        `Pays: ${paid} of ${name} to ${input.pay_to} from ${input.owner}'s escrow`,
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(payee.create.length === 0 ? [] : [`Setup: creates ${input.pay_to}'s ${name} account, paid by this wallet`]),
        ...(treasury.create.length === 0 ? [] : [`Setup: creates the engine treasury's ${name} account for the fee, paid by this wallet`]),
      ],
      warnings: [WARN_ATTESTOR],
      prepared,
    };
    return sent(ctx, signer, view2, input.send, call);
  },
});

export const MAX_RECURRING = 12;
export const MAX_EVERY = 30 * 24 * 60 * 60;

const walletRecurring = define({
  name: tool("wallet_recurring"),
  title: "Repeat a swap on a schedule",
  description: `Sell the same amount of one token for another several times, every so many seconds, from this server's wallet, with no bot left running: all orders are sent now and escrowed now. Each order holds its ask at start_receive, a little above the best recent fill, until its turn, then lets it fall to min_receive over falls_over seconds; it expires when the next one opens, or falls_over seconds after its own opening if that is later, and anyone can then return its escrow. Any order can be cancelled with ${tool("wallet_cancel")}. Each order pays the create fee and rent, and the rent returns when it closes. Amounts are whole tokens per order. Without send it only previews; show the user the summary, then call again with send: true and the start_receive the preview returned once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens each order sells, such as 0.05"),
    min_receive: text("least whole tokens each order receives"),
    every: integer(MIN_EXPIRES_IN, MAX_EVERY, "seconds between one order opening and the next"),
    times: integer(2, MAX_RECURRING, "how many orders"),
    start_receive: optional(text("whole tokens each order asks when it opens; default a little above the best recent fill")),
    falls_over: optional(integer(MIN_EXPIRES_IN, MAX_EVERY, `seconds each order's ask takes to fall to min_receive; default ${SWAP_FALLS_OVER}`)),
    pay_to: optional(account(PAY_TO)),
    send: optional(flag("true signs and sends every order; leave out to preview")),
  }),
  output: object({
    orders: list(
      object({ opens_at: time("when the order's ask starts to fall"), intent: optional(account()), nonce: optional(amount()), signature: optional(text()) }),
      MAX_RECURRING,
    ),
    summary: list(text(), 24, "the first order"),
    warnings: list(text(), 16),
    start_receive: text("whole tokens each order asks when it opens; pass it back when sending"),
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
    const floor = raw(input.min_receive, outputToken.decimals, "min_receive");
    const ask =
      input.start_receive === undefined
        ? openingAsk(await recentFills(ctx.transport, inputMint, outputMint), amountIn, floor)
        : raw(input.start_receive, outputToken.decimals, "start_receive");
    if (ask <= floor) {
      throw new InvalidInput([{ path: "start_receive", message: "must be more than min_receive, or the order has no ask to fall" }]);
    }
    checkSale(wallet.limits, inputMint, inputToken.decimals, amountIn, now);
    checkHour(wallet.limits, inputMint, inputToken.decimals, amountIn * BigInt(input.times), now);
    const falls = BigInt(input.falls_over ?? SWAP_FALLS_OVER);
    const every = BigInt(input.every);
    const life = falls > every ? falls : every;
    const opens = Array.from({ length: input.times }, (_, k) => now + BigInt(LANDING_SECONDS) + every * BigInt(k));
    const terms = (open: bigint) => () => ({
      order: { kind: "dutch" as const, amount_in: amountIn, start_out: ask, end_out: floor, start_time: open, end_time: open + falls },
      expires_at: open + life,
    });
    const shown = { start_receive: formatAmount(ask, outputToken.decimals) };
    const first = (await offered(ctx, call, { ...input, send: input.send }, terms(opens[0] as bigint))) as Record<string, unknown>;
    if (input.send !== true) {
      const { summary, warnings, next } = first as { summary: string[]; warnings: string[]; next: string };
      return { orders: opens.map((opens_at) => ({ opens_at })), summary, warnings, ...shown, sent: false, next };
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
          summary: first["summary"],
          warnings: first["warnings"],
          ...shown,
          sent: true,
          next: `${orders.length} of ${input.times} orders were sent; the next failed with ${problem.code}: ${problem.hint}`,
        };
      }
    }
    return { orders, summary: first["summary"], warnings: first["warnings"], ...shown, sent: true };
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
    pay_to: optional(account(PAY_TO)),
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
    received: optional(text("whole tokens the fills delivered, to this wallet or the pay_to it named")),
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
  walletRecurring,
  walletEscrow,
  walletAttest,
  walletWait,
  walletIntents,
  walletCancel,
];
