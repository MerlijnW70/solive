import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getBase16Decoder,
  getBase16Encoder,
  type Instruction,
  isSolanaError,
  type KeyPairSigner,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  signBytes,
  type TransactionSigner,
} from "@solana/kit";
import {
  attestedFillMessage,
  attestedProofMessage,
  attestedSplitMessage,
  attestedSplitPreimage,
  buildEd25519BatchInstruction,
  buildFillAttested,
  buildFillAttestedSplit,
  decodeEvent,
  decodeParams,
  feeBpsFor,
  findIntentPda,
  formatAmount,
  formatTime,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  isMemoUrl,
  MEMO_URL_RULE,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
  LONG_LIVED_SECONDS,
  MAX_SPLIT_RECIPIENTS,
  NATIVE_MINT,
  parseAmount,
  releaseMemo,
  signEd25519Instruction,
  splitCommit,
  splitFees,
  splitPayout,
  settlementWarnings,
  WARN_LONG_LIVED,
} from "@intent-engine/core";
import { decodeLookupTable } from "@intent-engine/solver";
import {
  announcements,
  chainTime,
  Charged,
  CLOCK_SYSVAR,
  createdAtOf,
  type EngineTransaction,
  explain,
  DELIVERY_PAGES,
  deliveryRecord,
  deliveryInstructions,
  firstDelivery,
  followUpInstructions,
  followUpMemo,
  followUpOf,
  MEMOS_PER_TRANSACTION,
  loadConfig,
  MEMO_PROGRAM_ADDRESS,
  mintOf,
  neverLanded,
  PACKET_DATA_SIZE,
  recordedDelivery,
  scan,
  SIGNATURE_PAGE,
  tokenAccountIfMissing,
  type Transport,
  unmemoized,
} from "@intent-engine/client";
import { ENV_KEYPAIR, type Env, WALLET_NOT_MAINNET, type WalletLimits } from "../args.js";
import { execute, type PreparedView } from "../flows.js";
import { TOKEN_NAMES, tokenNamed } from "../tokens.js";
import { balances, defaultMints, expandHome, FAUCET, type Files, PUBLIC_FAUCET, setup, withSettings } from "../wallet.js";
import { type AgentContext, type AnyAction, define } from "./actions.js";
import type { Call } from "./claims.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN, prepareCreate, WRAPPED } from "./create.js";
import { tool } from "./names.js";
import { AgentRefusal, problemOf } from "./problems.js";
import { listIntents } from "./read.js";
import { InvalidInput, account, amount, choice, flag, hex32, integer, list, object, optional, type Schema, text, time } from "./schema.js";
import { orderSchema, preparedSchema, preparedView } from "./shapes.js";
import { walletRecipient } from "./owner.js";
import { prepare, transactionSize } from "./prepare.js";
import { prepareCancel } from "./settle.js";
import { STATUS } from "../accounts.js";
import { fileSales, type Sale, type SaleBook, salesPath } from "./sales.js";

export type WalletGuard = { limits: WalletLimits; book: SaleBook };

export const walletGuard = (limits: WalletLimits, book: SaleBook = fileSales()): WalletGuard => ({ limits, book });

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

async function bookOf(wallet: WalletAccess): Promise<string | undefined> {
  const path = await savedKeypair(wallet);
  return path === undefined ? undefined : salesPath(resolve(expandHome(path, wallet.files.home)));
}

const live = (sales: readonly Sale[], now: bigint): Sale[] => sales.filter((s) => s.at > now - SALE_WINDOW);

async function salesOf(wallet: WalletAccess, now: bigint): Promise<Sale[]> {
  if (!limited(wallet.limits)) {
    return [];
  }
  const path = await bookOf(wallet);
  return path === undefined ? [] : live(await wallet.limits.book.read(path), now);
}

function checkSale(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint, sales: readonly Sale[]): void {
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
  checkHour(guard, mint, decimals, amount, now, sales);
}

function checkHour(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint, sales: readonly Sale[]): void {
  const hour = guard.limits.perHour.get(mint);
  const name = nameOf(mint);
  if (hour === undefined) {
    return;
  }
  const used = live(sales, now)
    .filter((s) => s.mint === mint)
    .reduce((sum, s) => sum + s.amount, 0n);
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
    "Create this server's devnet wallet if it has none, save it, and fund it from the devnet airdrop when it holds less than 0.5 SOL. Safe to call again: it reuses the saved wallet, and saves this server's RPC as the CLI's default only when none is saved. Call this first.",
  effect: "submit",
  destructive: false,
  input: object({}),
  output: object({
    address: account(),
    keypair: text("the file holding the wallet's key on this machine"),
    created: flag("true when this call made the wallet"),
    url: text("the RPC node this server uses, as scheme, host and port only"),
    settings: text("whether this call saved the RPC as the CLI's default; it does so only when none is saved yet"),
    sol: text("SOL the wallet holds"),
    next: text("what to tell the user"),
    notice: list(text(), 8, "the notice from the server instructions; show it if the user has not seen it yet"),
  }),
  run: async (ctx: AgentContext) => {
    const wallet = await testCluster(ctx);
    return { ...(await setup(ctx.transport, wallet.files, wallet.url, await savedKeypair(wallet), true)), notice: WALLET_NOTICE };
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

type Terms = { order: Order; expires_at: bigint; spec_url?: string };

async function offered(
  ctx: AgentContext,
  call: Call,
  input: { sell: string; buy: string; pay_to?: Address | undefined; send?: boolean | undefined },
  terms: (sold: Token, bought: Token, now: bigint, inputMint: Address, outputMint: Address) => Promise<Terms> | Terms,
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
  const sold = (made.order as { amount_in: bigint }).amount_in;
  const guard = wallet.limits;
  checkSale(guard, inputMint, inputToken.decimals, sold, now, await salesOf(wallet, now));
  const created = async (context: AgentContext) => {
    const view = (await prepareCreate.run(
      context,
      { owner: signer.address, input_mint: inputMint, output_mint: outputMint, ...(input.pay_to === undefined ? {} : { pay_to: input.pay_to }), ...made } as never,
      call,
    )) as Record<string, unknown>;
    const { intent, nonce, summary, warnings, prepared } = view;
    return { intent, nonce, summary, warnings, prepared };
  };
  const first = await created(ctx);
  if (input.send !== true) {
    return sent(ctx, signer, first, input.send, call);
  }
  const path = limited(guard) ? await bookOf(wallet) : undefined;
  const sale: Sale = { id: randomUUID(), mint: inputMint, at: now, amount: sold };
  if (path !== undefined) {
    await guard.book.update(path, (sales) => {
      const kept = live(sales, now);
      checkSale(guard, inputMint, inputToken.decimals, sold, now, kept);
      return { sales: [...kept, sale], value: undefined };
    });
  }
  try {
    try {
      return await sent(ctx, signer, first, true, call);
    } catch (error) {
      if (!nonceTaken(error)) {
        throw error;
      }
      return await sent(ctx, signer, await created({ ...ctx, transport: unmemoized(ctx.transport) }), true, call);
    }
  } catch (error) {
    if (path !== undefined && refusedBeforeSending(error)) {
      await guard.book.update(path, (sales) => ({ sales: sales.filter((s) => s.id !== sale.id), value: undefined })).catch(() => undefined);
    }
    throw error;
  }
}

const NONCE_COLLISIONS: ReadonlySet<string> = new Set(["NonceUsed", "NonceTaken"]);

export function nonceTaken(error: unknown): boolean {
  if (NONCE_COLLISIONS.has(problemOf(error).code) || explain(error)?.name === "NonceUsed") {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /already in use/i.test(text);
}

export const SWAP_FALLS_OVER = 120;
export const PAY_TO = "the wallet that receives what is bought, such as someone this wallet pays; default this wallet. This wallet pays for its token account if it has none";
export const SWAP_HEADROOM_BPS = 200n;
export const SWAP_BLIND_BPS = 2_500n;
export const SWAP_CAP_BPS = 20_000n;

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

const byRate = (fills: Fill[]): Fill[] =>
  [...fills].sort((a, b) => (a.delivered * b.amountIn < b.delivered * a.amountIn ? -1 : a.delivered * b.amountIn > b.delivered * a.amountIn ? 1 : 0));

const bestOf = (fills: Fill[]): Fill | undefined => byRate(fills).at(-1);

const medianOf = (fills: Fill[]): Fill | undefined => byRate(fills)[Math.floor((fills.length - 1) / 2)];

function openingAsk(fills: Fill[], amount: bigint, floor: bigint): bigint {
  const typical = medianOf(fills);
  const blind = (floor * (10_000n + SWAP_BLIND_BPS)) / 10_000n;
  const seen = typical === undefined ? 0n : (amount * typical.delivered * (10_000n + SWAP_HEADROOM_BPS)) / (typical.amountIn * 10_000n);
  const cap = (floor * SWAP_CAP_BPS) / 10_000n;
  const ask = seen > blind ? seen : blind;
  return ask < cap ? ask : cap;
}

const walletSwap = define({
  name: tool("wallet_swap"),
  title: "Swap from the wallet",
  description: `Sell an exact amount of one token for at least min_receive of another, from this server's wallet: the tokens are escrowed in an intent that a solver fills or that the wallet gets back. Solvers pay the least an intent asks, so by default the ask starts at start_receive, a little above the median of recent fills but at least a quarter above min_receive and at most twice it, and falls to min_receive over falls_over seconds (default ${SWAP_FALLS_OVER}): a solver takes it near the most it can pay. exact: true asks min_receive from the start instead. Amounts are whole tokens such as 0.05. Selling SOL wraps it first. Without send it only previews; show the user the summary, then call again with send: true and the start_receive the preview returned once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    min_receive: text("least whole tokens to receive for all of it"),
    start_receive: optional(text("whole tokens asked when the offer lands; default a little above the median recent fill, between 1.25 and 2 times min_receive")),
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

export const RECORD_MINT_NEEDED = "selling SOL on this RPC needs record_mint: any other token's mint, which only labels the escrow";

function recordedMint(sell: Address, url: string, chosen: string | undefined): Address {
  if (chosen !== undefined) {
    return mintNamed(chosen, url, "record_mint");
  }
  if (sell !== NATIVE_MINT) {
    return NATIVE_MINT;
  }
  const test = tokenNamed("TEST", url);
  if (test instanceof Error) {
    throw new InvalidInput([{ path: "record_mint", message: RECORD_MINT_NEEDED }]);
  }
  return test as Address;
}

const walletEscrow = define({
  name: tool("wallet_escrow"),
  title: "Escrow a payment for an attestor to release",
  description: `Hold an exact amount of one token from this server's wallet in an attested intent: it goes, minus the engine fee, to whichever wallet the named attestor later signs for, once the attestor attests a result between min_result and max_result. Use it to pay another agent for work that a third agent or a person judges. The attestor alone decides who is paid, so name an attestor the user trusts; with spec_hash the release must also be signed over that exact spec. spec_url publishes where that spec lives, so workers find the escrow with ${tool("find_jobs")} and announce their work to the attestor with ${tool("wallet_deliver")}. Have the worker deliver to the attestor rather than to this wallet, since this wallet can cancel until the release; ${tool("wallet_receipt")} later shows what the release recorded. Until then the wallet can cancel it with ${tool("wallet_cancel")}, and after it expires anyone can return the escrow. Amounts are whole tokens such as 0.05. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    amount: text("whole tokens to escrow, such as 0.05"),
    attestor: account("the wallet whose signature alone releases the escrow"),
    min_result: optional(amount("least result the attestor may attest; default 1")),
    max_result: optional(amount("greatest result the attestor may attest; default min_result")),
    spec_hash: optional(hex32("64 hex: the sha256 of the acceptance spec the attestor must verify. Setting it binds the release to a signature over that exact spec, so the attestor cannot sign a generic result")),
    spec_url: optional(text(`where the acceptance spec is published, ${MEMO_URL_RULE}; needs spec_hash. Recorded in a memo this wallet signs with the escrow`)),
    judge_fee: optional(text("whole tokens of sell paid to the attestor out of the escrow when it settles, such as 0.001; needs spec_hash and must be below amount")),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrow records as its output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
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
    const specHash = input.spec_hash;
    if (input.judge_fee !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "judge_fee", message: "needs spec_hash" }]);
    }
    if (input.spec_url !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "spec_url", message: "needs spec_hash" }]);
    }
    return offered(ctx, call, { sell: sold, buy: recordedMint(sold, wallet.url, input.record_mint), send: input.send }, (token, _, now) => ({
      order: {
        kind: "attested",
        amount_in: raw(input.amount, token.decimals, "amount"),
        min_result: least,
        max_result: most,
        attestor: input.attestor,
        ...(specHash === undefined ? {} : { spec_hash: specHash }),
        ...(input.judge_fee === undefined ? {} : { judge_fee: raw(input.judge_fee, token.decimals, "judge_fee") }),
      },
      expires_at: now + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
      ...(input.spec_url === undefined ? {} : { spec_url: input.spec_url }),
    }));
  },
});

export const MAX_PIECES = 12;

export const piecesPartlySent = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed; the next failed with ${problem}. To finish, escrow only the ${total - sent} remaining pieces; do not repeat this call`;

export const piecesMayHaveLanded = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed and the next may have landed too (${problem}); check ${tool("wallet_intents")} before escrowing any again, and do not repeat this call`;

type Piece = { name: string; amountIn: bigint; attestor: Address };

const walletEscrowPlan = define({
  name: tool("wallet_escrow_plan"),
  title: "Escrow a task's pieces in one plan",
  description: `Split a task into pieces and escrow each piece's payment from this server's wallet in one call, each as ${tool("wallet_escrow")} would: every piece is its own escrow that its attestor releases on its own, to whichever wallet it signs for, so workers are paid as each piece passes. One preview shows every piece and the total; one send escrows them all. A piece not yet released can be cancelled on its own with ${tool("wallet_cancel")}. Have workers deliver to the attestor rather than to this wallet. Amounts are whole tokens. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    attestor: account("the wallet that releases every piece that names no attestor of its own"),
    pieces: list(
      object({
        name: text("a label for the piece, shown in the plan only"),
        amount: text("whole tokens this piece pays, such as 0.01"),
        attestor: optional(account("this piece's attestor, instead of the plan's")),
      }),
      MAX_PIECES,
      "the pieces, in order",
      2,
    ),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds each escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrows record as their output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
    send: optional(flag("true signs and sends every piece; leave out to preview")),
  }),
  output: object({
    pieces: list(
      object({ name: text(), amount: text(), attestor: account(), intent: optional(account()), nonce: optional(amount()), signature: optional(text()) }),
      MAX_PIECES,
    ),
    total: text("whole tokens escrowed across all pieces"),
    summary: list(text(), 24, "the plan, then the first piece"),
    warnings: list(text(), 16),
    sent: flag(),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const buy = recordedMint(sold, wallet.url, input.record_mint);
    const [token, now] = await Promise.all([mintOf(ctx.transport, sold), chainTime(ctx.transport)]);
    const planned: Piece[] = input.pieces.map((piece, i) => ({
      name: piece.name,
      amountIn: raw(piece.amount, token.decimals, `pieces.${i}.amount`),
      attestor: piece.attestor ?? input.attestor,
    }));
    const total = planned.reduce((sum, piece) => sum + piece.amountIn, 0n);
    const sales = await salesOf(wallet, now);
    for (const piece of planned) {
      checkSale(wallet.limits, sold, token.decimals, piece.amountIn, now, sales);
    }
    checkHour(wallet.limits, sold, token.decimals, total, now, sales);
    const terms = (piece: Piece) => (_sold: Token, _bought: Token, at: bigint) => ({
      order: { kind: "attested" as const, amount_in: piece.amountIn, min_result: 1n, max_result: 1n, attestor: piece.attestor },
      expires_at: at + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
    });
    const name = TOKEN_NAMES[sold] ?? sold;
    const listed = (piece: Piece) => ({ name: piece.name, amount: formatAmount(piece.amountIn, token.decimals), attestor: piece.attestor });
    const [head, ...rest] = planned as [Piece, ...Piece[]];
    const first = (await offered(ctx, call, { sell: sold, buy, send: input.send }, terms(head))) as Record<string, unknown>;
    const shown = {
      total: formatAmount(total, token.decimals),
      summary: [
        `Plan: ${planned.length} pieces, ${formatAmount(total, token.decimals)} of ${name} in all, each escrowed now and released on its own`,
        ...planned.map((piece, i) => `Piece ${i + 1}: ${piece.name}, ${formatAmount(piece.amountIn, token.decimals)} of ${name}, released by ${piece.attestor}`),
        ...(first["summary"] as string[]),
      ],
      warnings: first["warnings"] as string[],
    };
    if (input.send !== true) {
      return { pieces: planned.map(listed), ...shown, sent: false, next: first["next"] };
    }
    const pieces = [{ ...listed(head), intent: first["intent"], nonce: first["nonce"], signature: first["signature"] }];
    for (const piece of rest) {
      try {
        const made = (await offered(ctx, call, { sell: sold, buy, send: true }, terms(piece))) as Record<string, unknown>;
        pieces.push({ ...listed(piece), intent: made["intent"], nonce: made["nonce"], signature: made["signature"] });
      } catch (error) {
        for (const undo of call.undo.splice(0)) {
          undo();
        }
        const problem = problemOf(error);
        const reason = `${problem.code}: ${problem.hint}`;
        return {
          pieces: [...pieces, ...planned.slice(pieces.length).map(listed)],
          ...shown,
          sent: true,
          next: refusedBeforeSending(error) ? piecesPartlySent(pieces.length, planned.length, reason) : piecesMayHaveLanded(pieces.length, planned.length, reason),
        };
      }
    }
    return { pieces, ...shown, sent: true };
  },
});

export const PAYEE_MOVED = "this wallet's token account for the escrowed token now belongs to someone else, so a release would not reach it; ask the payee for another wallet";

export const RELEASE_CHANGED = "this release differs from its preview: the payee, amount, result, fee or the escrow itself changed, or no approval was given; preview it again and show the user";

export const approvalOf = (message: Uint8Array, memo = ""): string => createHash("sha256").update(message).update(memo).digest("hex").slice(0, 16);

function sha256Of(text: string, path: string): string {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidInput([{ path, message: "give a sha256 as 64 hex digits" }]);
  }
  return hex;
}

const walletDeliver = define({
  name: tool("wallet_deliver"),
  title: "Announce delivered work to a judge",
  description: `As a worker, tell the attestor of a proof escrow, such as one found with ${tool("find_jobs")}, that the work is done: this server's wallet sends one transaction with a memo naming the escrow, the work's sha256 and the url the attestor fetches it from, and a transfer of 0 lamports to the attestor so the delivery shows in its history. It moves no tokens and costs only the transaction fee. The attestor alone decides whether the work passes and whom it pays, so host the work where the attestor can fetch it and give its exact sha256. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const { attestor, instructions } = await deliveryInstructions(ctx.transport, { worker: signer, intent: input.intent, sha256, url: input.url });
    const view = {
      intent: input.intent,
      attestor,
      sha256,
      url: input.url,
      summary: [
        `Announces: the work with sha256 ${sha256} at ${input.url}, for the proof escrow ${input.intent}`,
        `Notifies: its attestor ${attestor}, with a transfer of 0 lamports from this wallet`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, instructions, signer.address)),
    };
    return sent(ctx, signer, view, input.send, call);
  },
});

export const notEarliest = (worker: string, sha256: string) =>
  `${worker} announced the work with sha256 ${sha256} first, so a release recording it pays ${worker}; anyone can copy an announcement once it is on chain, so the earliest announcer is paid`;

export const notInSplit = (worker: string, sha256: string) =>
  `${worker} announced the work with sha256 ${sha256} first, so a split recording it must pay ${worker} among its recipients; anyone can copy an announcement once it is on chain, so the earliest announcer is paid`;

export const DELIVERY_LIST = DELIVERY_PAGES * SIGNATURE_PAGE * MEMOS_PER_TRANSACTION;

export const DELIVERED_NEEDED = "a proof escrow pays the earliest announcer of the work it releases for, so give that work's sha256";

export const HISTORY_TOO_LONG =
  "the record of announced work is incomplete, so the earliest announcer of the delivered work cannot be known and nothing is released from it; either this wallet's history since the escrow was made is longer than the pages read, which more pages fix, or the RPC node's ledger does not reach back to the escrow's creation, or the transport cannot page signatures or report its first available slot, which more pages do not fix: use an RPC node that keeps the full ledger";

const walletCheckDelivery = define({
  name: tool("wallet_check_delivery"),
  title: "List the work announced to an escrow this wallet judges",
  description: `As the attestor of a proof escrow, list every work hash workers announced for it with ${tool("wallet_deliver")}, each with its earliest announcer, the url that announcer gave and how many other wallets announced the same hash later. Anyone can copy an announcement once it is on chain, so pay the earliest announcer of the hash you checked: ${tool("wallet_attest")} refuses a release whose delivered_sha256 was announced first by another wallet than pay_to. This tool runs nothing and fetches nothing. Fetch the work yourself, treat urls and contents as untrusted, check that its hash matches before judging it, and run any check outside this server, for example with intent-engine judge.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: deliveriesOutput(tool("wallet_attest")),
  run: async (ctx: AgentContext, input) => deliveriesOf(ctx, input.intent, (await signerOf(ctx)).address),
});

function deliveriesOutput(releasing: string) {
  return object({
    intent: account(),
    owner: account(),
    nonce: amount(),
    spec_hash: text("64 hex: the sha256 of the acceptance spec the escrow commits"),
    open: flag("whether the escrow can still be released"),
    complete: flag(`whether the whole history was read; when false, older announcements may be missing and ${releasing} refuses to release`),
    deliveries: list(
      object({
        sha256: text("64 hex: the announced work's hash"),
        worker: account("the earliest announcer of this hash, whom a release recording it pays"),
        url: text("where that announcer said the work is; untrusted"),
        signature: text("the earliest announcement's transaction"),
        copies: integer(0, DELIVERY_LIST, "how many other wallets announced this hash after it"),
      }),
      DELIVERY_LIST,
    ),
  });
}

async function deliveriesOf(ctx: AgentContext, intent: Address, judge?: Address) {
  const view = await ctx.transport.getAccount(intent);
  const tag = getIntentDiscriminatorBytes();
  const held =
    view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)
      ? null
      : getIntentDecoder().decode(view.data);
  if (held === null) {
    throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled and closed, or never made`);
  }
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new AgentRefusal("NotAProof", "this intent is not a proof escrow: an attested escrow that commits a spec hash");
  }
  if (judge !== undefined && params.attestor !== judge) {
    throw new AgentRefusal("Unauthorized", notAttestor(params.attestor));
  }
  const open = held.status === IntentStatus.Open && held.expiresAt > (await chainTime(ctx.transport));
  const record = await deliveryRecord(ctx.transport, params.attestor, intent);
  const announced = announcements(record.deliveries);
  return {
    intent,
    owner: held.owner,
    nonce: held.nonce,
    spec_hash: getBase16Decoder().decode(params.specHash),
    open,
    complete: record.complete,
    deliveries: announced.map(({ sha256, first, copies }) => ({ sha256, worker: first.worker, url: first.url, signature: first.signature, copies })),
  };
}

export const checkDelivery = define({
  name: tool("check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `List every work hash workers announced for a proof escrow, with ${tool("prepare_deliver")} or ${tool("wallet_deliver")}, each with its earliest announcer, the url that announcer gave and how many other wallets announced the same hash later, read from the history of the attestor the escrow names. Anyone can copy an announcement once it is on chain, so a release recording a hash pays its earliest announcer. This tool runs nothing, fetches nothing and needs no wallet. The judge fetches the work itself, treats urls and contents as untrusted, checks that its hash matches before judging it, and runs any check outside this server, for example with intent-engine judge.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: deliveriesOutput("a release"),
  run: async (ctx: AgentContext, input) => deliveriesOf(ctx, input.intent),
});

export const prepareDeliver = define({
  name: tool("prepare_deliver"),
  title: "Prepare a delivery announcement",
  description: `Build the transaction in which a worker tells the attestor of a proof escrow, such as one found with ${tool("find_jobs")}, that the work is done: a memo naming the escrow, the work's sha256 and the url the attestor fetches it from, and a transfer of 0 lamports to the attestor so the delivery shows in its history. It moves no tokens and costs the worker only the transaction fee. Returns an unsigned transaction that already simulated successfully; the worker's wallet must sign and send it. The attestor alone decides whether the work passes and whom it pays, and a release pays the earliest announcer of a hash, so host the work where the attestor can fetch it, give its exact sha256 and send promptly.`,
  effect: "prepare",
  input: object({
    worker: account("the wallet that announces the work, signs and pays the fee, and is paid if a release records this work"),
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
  }),
  output: object({
    intent: account(),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    prepared: preparedSchema,
  }),
  run: async (ctx: AgentContext, input) => {
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const { attestor, instructions } = await deliveryInstructions(ctx.transport, { worker: createNoopSigner(input.worker), intent: input.intent, sha256, url: input.url });
    return {
      intent: input.intent,
      attestor,
      sha256,
      url: input.url,
      summary: [
        `Announces: the work with sha256 ${sha256} at ${input.url}, for the proof escrow ${input.intent}`,
        `Notifies: its attestor ${attestor}, with a transfer of 0 lamports from ${input.worker}`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, instructions, input.worker)),
    };
  },
});

export const notAttestor = (attestor: string) =>
  `this intent names ${attestor} as its attestor, not this server's wallet; only that key can release it`;

const walletAttest = define({
  name: tool("wallet_attest"),
  title: "Release an escrow as its attestor",
  description: `As the attestor an escrow names, sign that it pays pay_to and settle it on chain from this server's wallet: the escrowed tokens, minus the engine fee and any partner fee, go to pay_to's token account, which this creates if needed. Use it when this server's wallet was named attestor of an intent made with ${tool("wallet_escrow")} and the work it pays for is done. A release cannot be undone. Without send it only previews and signs nothing; show the user the summary and, once they approve, call again with send: true and the approval the preview returned, which holds the send to exactly what was previewed.`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    pay_to: account("the wallet to pay"),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for; required for a proof escrow, whose release pays that work's earliest announcer; recorded in a memo this wallet signs with the release, so the payer can check what it receives with ${tool("wallet_receipt")}`)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    pay_to: account(),
    payee: account("pay_to's token account that receives the escrow"),
    paid: text("whole tokens pay_to receives"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: optional(text("the sha256 the release records")),
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
    await walletRecipient(ctx.transport, input.pay_to, "pay_to");
    const token = await mintOf(ctx.transport, held.inputMint);
    const payee = await tokenAccountIfMissing(ctx.transport, signer, input.pay_to, held.inputMint, token.tokenProgram);
    if (payee.create.length === 0) {
      const existing = await ctx.transport.getAccount(payee.address);
      const holder = existing === null || existing.data.length < 64 ? null : getAddressDecoder().decode(existing.data.subarray(32, 64));
      if (holder !== input.pay_to) {
        throw new InvalidInput([{ path: "pay_to", message: PAYEE_MOVED }]);
      }
    }
    const amountIn = held.escrowed - held.filled;
    const isProof = params.specHash.some((b) => b !== 0);
    const settleAmount = amountIn - params.judgeFee;
    const maxFeeBps = feeBpsFor(config, held.kind) + held.partnerBps;
    const shares = splitFees(settleAmount, feeBpsFor(config, held.kind), held.partnerBps, held.partnerCutBps);
    const treasury =
      shares.protocol > 0n
        ? await tokenAccountIfMissing(ctx.transport, signer, config.feeRecipient, held.inputMint, token.tokenProgram)
        : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner =
      partnerPaid ? await tokenAccountIfMissing(ctx.transport, signer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge =
      isProof && params.judgeFee > 0n
        ? await tokenAccountIfMissing(ctx.transport, signer, signer.address, held.inputMint, token.tokenProgram)
        : { create: [] };
    const attestFields = {
      domain: Uint8Array.from(config.domain),
      intent,
      payee: payee.address,
      amountIn,
      result,
      filled: held.filled,
      revision: held.revision,
      maxFeeBps,
    };
    const message = isProof
      ? await attestedProofMessage(signer.address, { ...attestFields, specHash: params.specHash })
      : await attestedFillMessage(signer.address, attestFields);
    const settle = await buildFillAttested({
      solver: signer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      payee: payee.address,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(partnerPaid ? { partner: held.partner } : {}),
      ...(isProof && params.judgeFee > 0n ? { judge: signer.address } : {}),
      amountIn,
      result,
      maxFeeBps,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const paid = formatAmount(shares.net, token.decimals);
    const setup = [...payee.create, ...treasury.create, ...partner.create, ...judge.create];
    const delivered = input.delivered_sha256 === undefined ? undefined : sha256Of(input.delivered_sha256, "delivered_sha256");
    if (isProof && delivered === undefined) {
      throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
    }
    if (delivered !== undefined && isProof) {
      const record = await deliveryRecord(ctx.transport, signer.address, intent);
      if (!record.complete) {
        throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
      }
      const first = firstDelivery(record.deliveries, delivered);
      if (first !== null && first.worker !== input.pay_to) {
        throw new AgentRefusal("NotEarliestAnnouncer", notEarliest(first.worker, delivered));
      }
    }
    const memoText = delivered === undefined ? "" : releaseMemo(delivered);
    const memo =
      delivered === undefined
        ? []
        : [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(memoText) }];
    const approval = approvalOf(message, memoText);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    const prepared =
      input.send === true
        ? preparedView(await prepare(ctx.transport, [...setup, await signEd25519Instruction(signer, message), settle, ...memo], signer.address))
        : undefined;
    const view2 = {
      intent,
      pay_to: input.pay_to,
      payee: payee.address,
      paid,
      fee: formatAmount(shares.protocol + shares.partner, token.decimals),
      result,
      approval,
      ...(delivered === undefined ? {} : { delivered_sha256: delivered }),
      summary: [
        `Pays: ${paid} of ${name} to ${input.pay_to} from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...(isProof && params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        ...(isProof ? [`Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`] : []),
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        ...(delivered === undefined ? [] : [`Records: the delivered work's sha256 ${delivered}, in a memo this wallet signs with the release`]),
        ...(payee.create.length === 0 ? [] : [`Setup: creates ${input.pay_to}'s ${name} account, paid by this wallet`]),
        ...(treasury.create.length === 0 ? [] : [`Setup: creates the engine treasury's ${name} account for the fee, paid by this wallet`]),
        ...(partner.create.length === 0 ? [] : [`Setup: creates the partner ${held.partner}'s ${name} account for its fee, paid by this wallet`]),
      ],
      warnings: settlementWarnings(params),
      prepared,
    };
    return sent(ctx, signer, view2, input.send, call);
  },
});

export { PACKET_DATA_SIZE };
export const SPLIT_FITS = 2;
export const SPLIT_FITS_WITH_TABLE = 4;
export const splitTooLarge = (size: number, recipients: number, withTable: boolean): string =>
  `this ${recipients}-co-author split builds a ${size}-byte transaction without the delivery memo, over the ${PACKET_DATA_SIZE}-byte limit${withTable ? " even with the lookup table" : ""}; a release fits ${SPLIT_FITS} co-authors without a lookup table and ${SPLIT_FITS_WITH_TABLE} with one when their token accounts exist, and fewer when this wallet creates them in the same transaction${withTable ? ", so reduce recipients or pay the rest in a second release" : ", so pass lookup_table with the preview's lookup_accounts to fit more, or reduce recipients"}`;
export const RECORDS_SPLIT = (delivered: string): string =>
  `Records: the delivered work's sha256 ${delivered}, in a memo this wallet signs with the release, or in a follow-up transaction this wallet signs right after it when the release has no room for the memo`;
export const followUpFailed = (reason: string): string =>
  `the release landed, but the follow-up transaction that records the delivered work's sha256 failed, so the hash is not recorded on chain: ${reason}; to record it, call ${tool("wallet_record_delivery")} with the same owner, nonce and delivered_sha256, which sends the memo in record_memo for ${tool("wallet_receipt")} to read`;
export const SPLIT_WEIGHTS_WRONG = "the weights must be whole basis points that add up to 10000";
export const SPLIT_SIG_NEEDED = "every co-author must sign the split before send: true; preview returns the envelope each one signs";
export const SIGNATURE_PATTERN = "^[0-9a-fA-F]{128}$";
export const WARN_COAUTHORS = "every co-author must sign the exact split; a release pays only the recipients and weights they all signed";

const coauthor = object({
  wallet: account("the co-author's wallet"),
  weight: integer(1, 10_000, "this co-author's share in basis points; all weights must add up to 10000"),
  signature: optional(text("128 hex: this co-author's signature over the envelope the preview returned for this wallet; needed with send")),
});

const RECORDED_WHERE = ["release", "follow-up"] as const;

const recordedWhere: Schema<(typeof RECORDED_WHERE)[number] | false> = {
  json: {
    anyOf: [{ type: "string", enum: [...RECORDED_WHERE] }, { type: "boolean", const: false }],
    description:
      "where the sha256 was recorded: in a memo in the release, or in a follow-up transaction this wallet signed right after it because the release had no room for the memo; false when the follow-up failed, so the hash is not on chain",
  },
  read: (value, path) => (value === false ? false : choice(RECORDED_WHERE).read(value, path)),
};

const walletAttestSplit = define({
  name: tool("wallet_attest_split"),
  title: "Release a proof escrow split among co-authors",
  description: `As the attestor a proof escrow names, release it on chain divided among several co-authors by weight, from this server's wallet: the escrowed tokens, minus the engine fee, any partner fee and the judge fee, are split by the weights and paid to each co-author's token account, which this creates if needed. Every co-author must authorize the exact split: preview without send to get the digest and the envelope each wallet must sign, collect those signatures, then call again with send: true and each co-author's signature. Changing any recipient, weight or the result changes what everyone signs. The escrow must have been made with a spec_hash. A release cannot be undone. Without send it only previews and signs nothing; show the user the summary and, once they approve, call again with send: true and the approval the preview returned.`,
  effect: "submit",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    recipients: list(coauthor, MAX_SPLIT_RECIPIENTS, "the co-authors and their weighted shares, up to 8", 1),
    result: optional(amount("the result to attest, between the intent's min_result and max_result; default min_result")),
    lookup_table: optional(account("an address lookup table holding this split's lookup_accounts, to fit more co-authors under the transaction size limit; create one with the preview's lookup_accounts and pass it with send")),
    delivered_sha256: optional(text(`the sha256, as 64 hex digits, of the work this release pays for; required, since a release recording it must include that work's earliest announcer among the recipients; recorded in a memo this wallet signs with the release, or right after it when the release has no room for the memo, so the payer can check what it receives with ${tool("wallet_receipt")}`)),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true signs the attestation and settles; leave out to preview")),
  }),
  output: object({
    intent: account(),
    digest: text("64 hex: the split digest every co-author and this wallet sign over"),
    envelope: text("the one message every co-author and this wallet sign, as hex; collect each co-author's signature over it"),
    lookup_accounts: list(account(), 24, "put these in an address lookup table (solana address-lookup-table create, then extend) and pass it as lookup_table to fit more co-authors"),
    paid: list(object({ wallet: account(), weight: amount(), amount: text("whole tokens this co-author receives") }), MAX_SPLIT_RECIPIENTS),
    net: text("whole tokens shared among the co-authors"),
    fee: text("whole tokens kept as fees"),
    result: amount(),
    approval: text("pass it back with send: true; a send that would differ from this preview is refused"),
    delivered_sha256: optional(text("the sha256 the release records")),
    recorded: optional(recordedWhere),
    follow_up_signature: optional(text("the follow-up transaction that records the sha256, when recorded is follow-up")),
    record_memo: optional(text(`when recorded is false, the memo that records the sha256 for this release; ${tool("wallet_record_delivery")} sends it from this wallet with a zero transfer to the escrow`)),
    summary: list(text(), 12),
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
    if (!params.specHash.some((b) => b !== 0)) {
      throw new AgentRefusal("NotAProof", "a split release needs an escrow made with a spec_hash");
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
    const weights = input.recipients.map((r) => r.weight);
    if (weights.reduce((a, b) => a + b, 0) !== 10_000) {
      throw new InvalidInput([{ path: "recipients", message: SPLIT_WEIGHTS_WRONG }]);
    }
    const wallets = input.recipients.map((r) => r.wallet);
    for (const [i, r] of input.recipients.entries()) {
      await walletRecipient(ctx.transport, r.wallet, `recipients.${i}.wallet`);
    }
    if (input.delivered_sha256 === undefined) {
      throw new InvalidInput([{ path: "delivered_sha256", message: DELIVERED_NEEDED }]);
    }
    const delivered = sha256Of(input.delivered_sha256, "delivered_sha256");
    const record = await deliveryRecord(ctx.transport, signer.address, intent);
    if (!record.complete) {
      throw new AgentRefusal("HistoryTooLong", HISTORY_TOO_LONG);
    }
    const first = firstDelivery(record.deliveries, delivered);
    if (first !== null && !wallets.includes(first.worker)) {
      throw new AgentRefusal("NotEarliestAnnouncer", notInSplit(first.worker, delivered));
    }
    const memoText = releaseMemo(delivered);
    const memo = { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(memoText) };
    const token = await mintOf(ctx.transport, held.inputMint);
    const payees = await Promise.all(wallets.map((w) => tokenAccountIfMissing(ctx.transport, signer, w, held.inputMint, token.tokenProgram)));
    const amountIn = held.escrowed - held.filled;
    const settleAmount = amountIn - params.judgeFee;
    const maxFeeBps = feeBpsFor(config, held.kind) + held.partnerBps;
    const shares = splitFees(settleAmount, feeBpsFor(config, held.kind), held.partnerBps, held.partnerCutBps);
    const payout = splitPayout(shares.net, weights);
    const treasury = shares.protocol > 0n ? await tokenAccountIfMissing(ctx.transport, signer, config.feeRecipient, held.inputMint, token.tokenProgram) : { create: [] };
    const partnerPaid = shares.partner > 0n;
    const partner = partnerPaid ? await tokenAccountIfMissing(ctx.transport, signer, held.partner, held.inputMint, token.tokenProgram) : { create: [] };
    const judge = params.judgeFee > 0n ? await tokenAccountIfMissing(ctx.transport, signer, signer.address, held.inputMint, token.tokenProgram) : { create: [] };
    const splitHash = await splitCommit(wallets, weights);
    const fields = {
      domain: Uint8Array.from(config.domain),
      intent,
      amountIn,
      result,
      filled: held.filled,
      revision: held.revision,
      maxFeeBps,
      specHash: params.specHash,
      splitHash,
    };
    const message = await attestedSplitMessage(fields);
    const digestHex = getBase16Decoder().decode(Uint8Array.from(createHash("sha256").update(await attestedSplitPreimage(fields)).digest()));
    const settle = await buildFillAttestedSplit({
      solver: signer,
      owner: input.owner,
      nonce: input.nonce,
      inputMint: held.inputMint,
      inputTokenProgram: token.tokenProgram,
      recipients: wallets,
      weights,
      ...(shares.protocol > 0n ? { feeRecipient: config.feeRecipient } : {}),
      ...(partnerPaid ? { partner: held.partner } : {}),
      ...(params.judgeFee > 0n ? { judge: signer.address } : {}),
      amountIn,
      result,
      maxFeeBps,
    });
    const name = TOKEN_NAMES[held.inputMint] ?? held.inputMint;
    const approval = approvalOf(message, memoText);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", RELEASE_CHANGED);
    }
    let batch;
    if (input.send === true) {
      const entries = input.recipients.map((r, i) => {
        if (r.signature === undefined || !new RegExp(SIGNATURE_PATTERN).test(r.signature)) {
          throw new InvalidInput([{ path: `recipients.${i}.signature`, message: SPLIT_SIG_NEEDED }]);
        }
        return { publicKey: r.wallet, signature: Uint8Array.from(getBase16Encoder().encode(r.signature)) };
      });
      const attestorSignature = new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
      batch = buildEd25519BatchInstruction({ entries: [...entries, { publicKey: signer.address, signature: attestorSignature }], message });
    }
    const setup = [...payees.flatMap((p) => p.create), ...treasury.create, ...partner.create, ...judge.create];
    const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, token.tokenProgram, signer.address]);
    const lookupAccounts = [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a));
    let tables: Record<Address, Address[]> | undefined;
    if (input.send === true && input.lookup_table !== undefined) {
      const view = await ctx.transport.getAccount(input.lookup_table);
      if (view === null) {
        throw new AgentRefusal("NotFound", `no lookup table ${input.lookup_table} on this cluster`);
      }
      tables = { [input.lookup_table]: decodeLookupTable(view.data) };
    }
    let prepared;
    let followUp = false;
    if (input.send === true && batch !== undefined) {
      const sizeOf = async (ixs: Parameters<typeof prepare>[1]) =>
        transactionSize(ctx.transport, await ctx.transport.budget(ixs, signer.address, tables), signer.address, tables);
      const bare = [...setup, batch, settle];
      followUp = (await sizeOf([...bare, memo])) > PACKET_DATA_SIZE;
      if (followUp) {
        const size = await sizeOf(bare);
        if (size > PACKET_DATA_SIZE) {
          throw new AgentRefusal("ReleaseTooLarge", splitTooLarge(size, input.recipients.length, input.lookup_table !== undefined));
        }
      }
      prepared = preparedView(await prepare(ctx.transport, followUp ? bare : [...bare, memo], signer.address, tables));
    }
    const view2 = {
      intent,
      digest: digestHex,
      envelope: getBase16Decoder().decode(message),
      lookup_accounts: lookupAccounts,
      paid: input.recipients.map((r, i) => ({
        wallet: r.wallet,
        weight: BigInt(r.weight),
        amount: formatAmount(payout[i] ?? 0n, token.decimals),
      })),
      net: formatAmount(shares.net, token.decimals),
      fee: formatAmount(shares.protocol + shares.partner + params.judgeFee, token.decimals),
      result,
      approval,
      delivered_sha256: delivered,
      summary: [
        `Splits: ${formatAmount(shares.net, token.decimals)} of ${name} among ${input.recipients.length} co-authors from ${input.owner}'s escrow${held.inputMint === NATIVE_MINT ? WRAPPED : ""}`,
        ...input.recipients.map((r, i) => `  ${r.wallet}: ${r.weight} bps -> ${formatAmount(payout[i] ?? 0n, token.decimals)} of ${name}`),
        ...(params.judgeFee > 0n ? [`Pays the judge: ${formatAmount(params.judgeFee, token.decimals)} of ${name} to this wallet, carved out of the escrow`] : []),
        `Binds: the result to the committed spec ${getBase16Decoder().decode(params.specHash)}`,
        `Attests: result ${result}, signed by this server's wallet as the escrow's attestor`,
        RECORDS_SPLIT(delivered),
        ...(setup.length === 0 ? [] : [`Setup: creates ${setup.length} token account(s), paid by this wallet`]),
      ],
      warnings: [...settlementWarnings(params), WARN_COAUTHORS],
      prepared,
    };
    const done = await sent(ctx, signer, view2, input.send, call);
    if (!("signature" in done)) {
      return done;
    }
    if (!followUp) {
      return { ...done, recorded: "release" as const };
    }
    const unrecorded = (error: unknown) => ({
      ...done,
      recorded: false as const,
      record_memo: followUpMemo(delivered, done.signature),
      next: followUpFailed(problemOf(error).hint),
    });
    let recording;
    try {
      recording = preparedView(await prepare(ctx.transport, followUpInstructions(signer, intent, delivered, done.signature), signer.address));
    } catch (error) {
      return unrecorded(error);
    }
    try {
      return { ...done, recorded: "follow-up" as const, follow_up_signature: await execute(ctx.transport, recording, signer) };
    } catch (error) {
      if (neverLanded(error)) {
        return unrecorded(error);
      }
      const landed = await ctx.transport
        .engineTransactions(WAIT_SCAN, intent)
        .then((transactions) => followUpOf(transactions, done.signature, signer.address))
        .catch(() => null);
      return landed === null || landed.sha256 !== delivered ? unrecorded(error) : { ...done, recorded: "follow-up" as const, follow_up_signature: landed.signature };
    }
  },
});

export const notReleasedYet = (intent: string) =>
  `no release of the escrow ${intent} is in its history, so no delivery can be recorded for it`;

export const alreadyRecorded = (sha256: string) =>
  `this release already records the delivered work's sha256 ${sha256}, which a receipt reads; nothing more is recorded`;

export const releasedBy = (attestor: string, signer: string) =>
  `this escrow was released by its attestor ${attestor}, not by ${signer}; only the attestor that released it records what it paid for`;

export type Recording = { intent: Address; release: string; attestor: Address; sha256: string; memo: string; instructions: Instruction[]; summary: string[] };

export async function recordingOf(transport: Transport, judge: TransactionSigner, owner: Address, nonce: bigint, sha256: string): Promise<Recording> {
  const [intent] = await findIntentPda({ owner, nonce });
  const transactions = await escrowHistory(transport, intent);
  for (const tx of transactions) {
    if (tx.failed) {
      continue;
    }
    const release = tx.emitted
      .map(decodeEvent)
      .find((event) => (event?.name === "IntentAttested" || event?.name === "IntentSplit") && (event.fields as Record<string, unknown>)["intent"] === intent);
    if (release === undefined || release === null) {
      continue;
    }
    const attestor = (release.fields as Record<string, unknown>)["attestor"] as Address;
    if (attestor !== judge.address) {
      throw new AgentRefusal("Unauthorized", releasedBy(attestor, judge.address));
    }
    const recorded = recordedDelivery(transactions, tx, attestor);
    if (recorded !== null) {
      throw new AgentRefusal("AlreadyRecorded", alreadyRecorded(recorded));
    }
    return {
      intent,
      release: tx.signature,
      attestor,
      sha256,
      memo: followUpMemo(sha256, tx.signature),
      instructions: followUpInstructions(judge, intent, sha256, tx.signature),
      summary: [
        `Records: the delivered work's sha256 ${sha256} for the release ${tx.signature} of the escrow ${intent}, in a memo ${attestor} signs`,
        `Notifies: the escrow ${intent}, with a transfer of 0 lamports, so the memo shows in its history`,
        "Costs: the transaction fee; no tokens move",
      ],
    };
  }
  throw new AgentRefusal("NotReleased", notReleasedYet(intent));
}

const walletRecordDelivery = define({
  name: tool("wallet_record_delivery"),
  title: "Record which work a release paid for",
  description: `As the attestor that released a proof escrow, record the sha256 of the delivered work the release paid for when the release itself recorded none, such as when ${tool("wallet_attest_split")} returned recorded: false: this server's wallet sends one transaction with the follow-up memo naming the release and the sha256, and a transfer of 0 lamports to the escrow so ${tool("wallet_receipt")} reads it. It refuses unless the escrow has a release, made by this wallet, that records no sha256 yet. It moves no tokens and costs only the transaction fee. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  destructive: false,
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    sha256: text("the sha256, as 64 hex digits, of the work the release paid for: the delivered_sha256 it was sent with"),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    release: text("the release's transaction"),
    sha256: text(),
    memo: text("the memo the transaction records"),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const sha256 = sha256Of(input.sha256, "sha256");
    const recording = await recordingOf(ctx.transport, signer, input.owner, input.nonce, sha256);
    const view = {
      intent: recording.intent,
      release: recording.release,
      sha256,
      memo: recording.memo,
      summary: recording.summary,
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, recording.instructions, signer.address)),
    };
    return sent(ctx, signer, view, input.send, call);
  },
});

export const MAX_RECURRING = 12;

export const mayHaveLanded = (sent: number, times: number, problem: string) =>
  `${sent} of ${times} orders were sent and the next may have landed too (${problem}); check ${tool("wallet_intents")} before sending any again, and do not repeat this call`;

export const partlySent = (sent: number, times: number, problem: string) =>
  `${sent} of ${times} orders were sent; the next failed with ${problem}. To finish, schedule only the ${times - sent} remaining orders; do not repeat this call`;

export const WARN_EARLY = "an order fills before its turn if a solver can already pay its start_receive";

export const NO_FALL = "must be more than 0, or the orders have no ask to fall";

const UNREACHED: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

const RPC_CAUSE_DEPTH = 8;
const JSON_RPC_FIRST = -32_000;
const JSON_RPC_LAST = -32_768;

export function rpcRefused(error: unknown): boolean {
  if (error instanceof Charged) {
    return false;
  }
  let link: unknown = error;
  for (let depth = 0; depth < RPC_CAUSE_DEPTH && link instanceof Error; depth++, link = link.cause) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return link.context.statusCode >= 400 && link.context.statusCode < 500;
    }
    if (isSolanaError(link) && link.context.__code <= JSON_RPC_FIRST && link.context.__code >= JSON_RPC_LAST) {
      return true;
    }
    if (UNREACHED.has((link as { code?: unknown }).code)) {
      return true;
    }
  }
  return false;
}

const refusedBeforeSending = (error: unknown): boolean =>
  neverLanded(error) || error instanceof AgentRefusal || error instanceof InvalidInput || rpcRefused(error);
export const MAX_EVERY = 30 * 24 * 60 * 60;

const walletRecurring = define({
  name: tool("wallet_recurring"),
  title: "Repeat a swap on a schedule",
  description: `Sell the same amount of one token for another several times, every so many seconds, from this server's wallet, with no bot left running: all orders are sent now and escrowed now. Each order holds its ask at start_receive until its turn, then lets it fall to min_receive over falls_over seconds; it expires when the next one opens, or falls_over seconds after its own opening if that is later, and anyone can then return its escrow. An order fills before its turn if a solver can already pay start_receive, so set it above what solvers pay now to hold the orders. Any order can be cancelled with ${tool("wallet_cancel")}. Each order pays the create fee and rent, and the rent returns when it closes. Amounts are whole tokens per order. Without send it only previews; show the user the summary, then call again with send: true and the start_receive the preview returned once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens each order sells, such as 0.05"),
    min_receive: text("least whole tokens each order receives"),
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
    const shown = { start_receive: formatAmount(ask, outputToken.decimals) };
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
    return { orders, summary: plan, warnings, ...shown, sent: true };
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
    "Cancel an open intent of this server's wallet by its nonce: the escrow returns to the wallet's token account (wrapped SOL for SOL) and the intent account closes, returning its rent. Without send it only previews; call again with send: true once the user approves.",
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

export const HISTORY_PAGES = 10;

const createdIn = (tx: EngineTransaction, intent: Address): boolean =>
  !tx.failed &&
  tx.emitted.some((data) => {
    const event = decodeEvent(data);
    return event?.name === "IntentCreated" && (event.fields as Record<string, unknown>)["intent"] === intent;
  });

export async function escrowHistory(transport: Transport, intent: Address): Promise<EngineTransaction[]> {
  const floor = await createdAtOf(transport, intent);
  return (await scan(transport, intent, { floor, pages: HISTORY_PAGES, until: (tx) => createdIn(tx, intent) })).transactions;
}

async function engineHistory(transport: Transport, limit: number) {
  return historyIn(await transport.engineTransactions(limit));
}

function historyIn(transactions: readonly EngineTransaction[]) {
  const created = new Map<Address, Pair>();
  const fills: Fill[] = [];
  const ended = new Map<Address, "cancelled" | "expired">();
  let unread = 0;
  for (const tx of transactions) {
    if (tx.unread === true) {
      unread += 1;
    }
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
  return { created, fills, ended, unread };
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
  "solvers pay the least an intent asks, so these fills show what owners asked and got, not the most a solver would pay; ask a minimum near receive_at_median, since a single fill can be staged by one party on both sides, or auction from a little above it down to the least the user accepts to find the price";

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

export const WAIT_STATUS = ["open", "filling", "filled", "cancelled", "expired", "closed"] as const;

type WaitStatus = (typeof WAIT_STATUS)[number];

export const UNREAD = `the node could not yet return all of this intent's transactions, so whether it filled is unknown; call ${tool("wallet_wait")} again in a few seconds before acting on it`;

export const stillWaiting = (status: string) =>
  `still ${status}; call ${tool("wallet_wait")} again to keep waiting, or ${tool("wallet_cancel")} to take the escrow back`;

const walletWait = define({
  name: tool("wallet_wait"),
  title: "Wait for a wallet intent",
  description: `Wait until an intent of this server's wallet is filled, cancelled or expired, or until within seconds pass, then say which and, for a fill, how much it delivered to this wallet or to the pay_to it named. Use it after sending instead of asking the user to check again; call it again while the status is still open.`,
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
    const history = historyIn(await escrowHistory(ctx.transport, intent));
    const fills = history.fills.filter((f) => f.intent === intent);
    if (fills.length === 0) {
      const ended = status === "closed" ? (history.ended.get(intent) ?? status) : status;
      return { intent, status: ended, waited, ...(ended === "closed" && history.unread > 0 ? { next: UNREAD } : {}) };
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

export const NOT_RELEASED = `no release of this escrow is in its history; ${tool("wallet_wait")} or ${tool("wallet_intents")} shows whether it is still open`;

const receiptOutput = object({
  intent: account(),
  released: flag(),
  paid_to: optional(account("the wallet the release paid")),
  payee: optional(account("the token account the release paid")),
  paid: optional(text("whole tokens the payee received")),
  attestor: optional(account()),
  result: optional(amount()),
  recipients: optional(amount("how many co-authors a split release paid")),
  signature: optional(text("the release's transaction")),
  delivered_sha256: optional(text("the sha256 the release recorded, if any, in its own memo or in a follow-up transaction its attestor signed")),
  matches: optional(flag("whether sha256 equals the recorded one")),
  next: optional(text()),
});

const walletReceipt = define({
  name: tool("wallet_receipt"),
  title: "Check an escrow's release",
  description: `Look up whether an escrow made with ${tool("wallet_escrow")} was released: to whom, for how much, by which attestor, and which delivered work the release recorded. Give sha256, the hash of the work you received, to check it is the work that was paid for. It reads the escrow's own transactions and sends nothing.`,
  effect: "read",
  input: object({
    owner: optional(account("the wallet that made the escrow; default this server's wallet")),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work you received, to compare with the one the release recorded")),
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) => receiptOf(ctx, input.owner ?? (await signerOf(ctx)).address, input.nonce, input.sha256),
});

export const getReceipt = define({
  name: tool("get_receipt"),
  title: "Check an escrow's release",
  description: `Look up whether an escrow was released: to whom, for how much, by which attestor, and which delivered work the release recorded. Give sha256, the hash of the work you received, to check it is the work that was paid for. It reads the escrow's own transactions, sends nothing and needs no wallet.`,
  effect: "read",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work you received, to compare with the one the release recorded")),
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) => receiptOf(ctx, input.owner, input.nonce, input.sha256),
});

async function receiptOf(ctx: AgentContext, owner: Address, nonce: bigint, sha256: string | undefined) {
  const wanted = sha256 === undefined ? undefined : sha256Of(sha256, "sha256");
  const [intent] = await findIntentPda({ owner, nonce });
  const transactions = await escrowHistory(ctx.transport, intent);
  let mint: Address | undefined;
  for (const tx of transactions) {
    for (const event of tx.emitted.map(decodeEvent)) {
      const fields = (event?.fields ?? {}) as Record<string, unknown>;
      if (event?.name === "IntentCreated" && fields["intent"] === intent) {
        mint = fields["inputMint"] as Address;
      }
    }
  }
  for (const tx of transactions) {
    if (tx.failed) {
      continue;
    }
    const release = tx.emitted
      .map(decodeEvent)
      .find((event) => (event?.name === "IntentAttested" || event?.name === "IntentSplit") && (event.fields as Record<string, unknown>)["intent"] === intent);
    if (release === undefined || release === null) {
      continue;
    }
    const fields = release.fields as Record<string, unknown>;
    const recorded = recordedDelivery(transactions, tx, fields["attestor"] as Address) ?? undefined;
    const common = {
      intent,
      released: true,
      attestor: fields["attestor"] as Address,
      result: fields["result"] as bigint,
      signature: tx.signature,
      ...(recorded === undefined ? {} : { delivered_sha256: recorded }),
      ...(wanted === undefined ? {} : { matches: wanted === recorded }),
    };
    if (release.name === "IntentSplit") {
      const decimals = mint === undefined ? undefined : (await mintOf(ctx.transport, mint)).decimals;
      return { ...common, paid: formatAmount(fields["net"] as bigint, decimals), recipients: BigInt(fields["recipients"] as number) };
    }
    const payee = fields["payee"] as Address;
    const held = await ctx.transport.getAccount(payee);
    mint ??= held === null || held.data.length < 64 ? undefined : getAddressDecoder().decode(held.data.subarray(0, 32));
    const decimals = mint === undefined ? undefined : (await mintOf(ctx.transport, mint)).decimals;
    return {
      ...common,
      ...(held === null || held.data.length < 64 ? {} : { paid_to: getAddressDecoder().decode(held.data.subarray(32, 64)) }),
      payee,
      paid: formatAmount(fields["net"] as bigint, decimals),
    };
  }
  return { intent, released: false, next: NOT_RELEASED };
}

export const WALLET_ACTIONS: readonly AnyAction[] = [
  walletSetup,
  walletBalance,
  walletEstimate,
  walletSwap,
  walletAuction,
  walletRecurring,
  walletEscrow,
  walletEscrowPlan,
  walletAttest,
  walletAttestSplit,
  walletRecordDelivery,
  walletDeliver,
  walletCheckDelivery,
  walletWait,
  walletReceipt,
  walletIntents,
  walletCancel,
];
