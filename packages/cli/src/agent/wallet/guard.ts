import { resolve } from "node:path";
import {
  type Address,
  isAddress,
  isSolanaError,
  type KeyPairSigner,
  type MessagePartialSigner,
  type SignatureBytes,
  signBytes,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type TransactionPartialSigner,
} from "@solana/kit";
import { formatAmount, parseAmount } from "@intent-engine/core";
import { Charged, type DeviceSigner, isLedgerPath, LedgerError, ledgerSigner, neverLanded, openUsb } from "@intent-engine/client";
import { ENV_KEYPAIR, type Env, WALLET_NOT_MAINNET, type WalletLimits } from "../../args.js";
import { execute, type PreparedView } from "../../flows.js";
import { TOKEN_NAMES, tokenNamed } from "../../tokens.js";
import { expandHome, faucetLink, type Files, ledgerBook, PUBLIC_FAUCET, withSettings } from "../../wallet.js";
import { needsKeyFile } from "../../ledger-keys.js";
import type { AgentContext } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput } from "../schema.js";
import { fileSales, type Sale, type SaleBook, salesPath } from "../sales.js";

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

export type Clock = Pick<WalletAccess, "sleep" | "now">;

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
  "Test network only: this wallet refuses mainnet, and its tokens have no value.",
  "Your key stays on this computer; only signed transactions leave it.",
  "This server talks only to the Solana node (RPC) it started with.",
  "Nothing moves until you say yes: payments are previewed first.",
  "Never send real money to this wallet or use its key anywhere else.",
];

export const PREVIEW_FIRST = "Previews only; call with send: true after the user says yes.";
export const PREVIEW_APPROVAL = "Previews only; after the user says yes, call with send: true and its approval.";

export const walletEmpty = (address: string) =>
  `no SOL yet; call ${tool("wallet_setup")} for free devnet SOL, or fund ${address} at ${faucetLink(address)}`;

export const NO_WALLET = `this server has no wallet yet; call ${tool("wallet_setup")} first`;
export const WALLET_OFF = "this server runs without a wallet; start it with mcp --wallet to let it sign";
export const PREVIEW_ONLY = "not sent; show the summary, then resend with send: true after approval";
export const PREVIEW_APPROVAL_NEXT = "not sent; show the summary, then resend with send: true and the approval above";

export function access(ctx: AgentContext): WalletAccess {
  if (ctx.wallet === undefined) {
    throw new AgentRefusal("WalletNotConfigured", WALLET_OFF);
  }
  return ctx.wallet;
}

const genesisOf = new WeakMap<WalletAccess, Promise<string>>();

export async function testCluster(ctx: AgentContext): Promise<WalletAccess> {
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

export async function savedKeypair(wallet: WalletAccess): Promise<string | undefined> {
  return (await withSettings(wallet.files, wallet.env))[ENV_KEYPAIR];
}

export async function walletKeypair(ctx: AgentContext): Promise<Uint8Array | undefined> {
  if (ctx.wallet === undefined) {
    return undefined;
  }
  const path = await savedKeypair(ctx.wallet);
  if (path === undefined || isLedgerPath(path)) {
    return undefined;
  }
  try {
    return await ctx.wallet.files.loadKeypair(path);
  } catch {
    return undefined;
  }
}

export type WalletSigner = TransactionPartialSigner &
  MessagePartialSigner & {
    signBytes(bytes: Uint8Array): Promise<SignatureBytes>;
    readonly device?: string;
  };

async function notMainnet(ctx: AgentContext): Promise<void> {
  if ((await ctx.transport.genesisHash()) === MAINNET_GENESIS) {
    throw new AgentRefusal("WalletNotMainnet", WALLET_NOT_MAINNET);
  }
}

export function guardedSigner(ctx: AgentContext, key: KeyPairSigner): WalletSigner {
  const checked = async <T>(sign: () => Promise<T>): Promise<T> => {
    await notMainnet(ctx);
    return sign();
  };
  return Object.freeze({
    address: key.address,
    signMessages: (messages, config) => checked(() => key.signMessages(messages, config)),
    signTransactions: (transactions, config) => checked(() => key.signTransactions(transactions, config)),
    signBytes: (bytes) => checked(() => signBytes(key.keyPair.privateKey, bytes)),
  } satisfies WalletSigner);
}

export function deviceSigner(ctx: AgentContext, device: DeviceSigner): WalletSigner {
  const checked = async <T>(sign: () => Promise<T>): Promise<T> => {
    await notMainnet(ctx);
    return sign();
  };
  const signMessages: WalletSigner["signMessages"] = (messages, config) => checked(() => device.signMessages(messages, config));
  return Object.freeze({
    address: device.address,
    device: device.device,
    signMessages,
    signTransactions: (transactions, config) => checked(() => device.signTransactions(transactions, config)),
    signBytes: async (bytes) => {
      const [signed] = await signMessages([{ content: bytes, signatures: {} }]);
      const signature = signed?.[device.address];
      if (signature === undefined) {
        throw new LedgerError(`the Ledger returned no signature for ${device.address}; nothing was sent`);
      }
      return signature;
    },
  } satisfies WalletSigner);
}

export function keyFileOnly(signer: WalletSigner, name: string): void {
  if (signer.device !== undefined) {
    throw new AgentRefusal("LedgerNeedsKeyFile", needsKeyFile(name, signer.device));
  }
}

const devices = new WeakMap<Files, Map<string, Promise<DeviceSigner>>>();

function deviceAt(wallet: WalletAccess, path: string): Promise<DeviceSigner> {
  const known = devices.get(wallet.files) ?? new Map<string, Promise<DeviceSigner>>();
  devices.set(wallet.files, known);
  const found = known.get(path);
  if (found !== undefined) {
    return found;
  }
  const opening = ledgerSigner(path, wallet.files.ledger ?? openUsb);
  known.set(path, opening);
  opening.catch(() => {
    if (known.get(path) === opening) {
      known.delete(path);
    }
  });
  return opening;
}

export async function signerOf(ctx: AgentContext): Promise<WalletSigner> {
  const wallet = await testCluster(ctx);
  const path = await savedKeypair(wallet);
  if (path === undefined) {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
  if (isLedgerPath(path)) {
    return deviceSigner(ctx, await deviceAt(wallet, path));
  }
  let key: KeyPairSigner;
  try {
    key = await wallet.files.loadSigner(path);
  } catch {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
  return guardedSigner(ctx, key);
}

export function mintNamed(text: string, url: string, path: string): Address {
  const mint = tokenNamed(text.trim(), url);
  if (mint instanceof Error) {
    throw new InvalidInput([{ path, message: mint.message }]);
  }
  if (!isAddress(mint)) {
    throw new InvalidInput([{ path, message: "name SOL, TEST or a token mint address" }]);
  }
  return mint;
}

export function raw(tokens: string, decimals: number, path: string): bigint {
  try {
    return parseAmount(tokens, decimals);
  } catch (error) {
    throw new InvalidInput([{ path, message: error instanceof Error ? error.message : String(error) }]);
  }
}

export const nameOf = (mint: Address): string => TOKEN_NAMES[mint] ?? mint;

export const limited = (guard: WalletGuard): boolean => guard.limits.perTrade.size + guard.limits.perHour.size > 0;

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

export async function bookOf(wallet: WalletAccess): Promise<string | undefined> {
  const path = await savedKeypair(wallet);
  if (path === undefined) {
    return undefined;
  }
  return isLedgerPath(path) ? ledgerBook(wallet.files.home, path) : salesPath(resolve(expandHome(path, wallet.files.home)));
}

export const live = (sales: readonly Sale[], now: bigint): Sale[] => sales.filter((s) => s.at > now - SALE_WINDOW);

export async function salesOf(wallet: WalletAccess, now: bigint): Promise<Sale[]> {
  if (!limited(wallet.limits)) {
    return [];
  }
  const path = await bookOf(wallet);
  return path === undefined ? [] : live(await wallet.limits.book.read(path), now);
}

export function checkSale(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint, sales: readonly Sale[]): void {
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

export function checkHour(guard: WalletGuard, mint: Address, decimals: number, amount: bigint, now: bigint, sales: readonly Sale[]): void {
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

export async function sent(
  ctx: AgentContext,
  signer: WalletSigner,
  view: Record<string, unknown>,
  send: boolean | undefined,
  call: Call,
  next?: { preview?: string | undefined; done?: string | undefined },
) {
  for (const undo of call.undo.splice(0)) {
    undo();
  }
  const { prepared, ...shown } = view as { prepared: PreparedView } & Record<string, unknown>;
  if (send !== true) {
    return { ...shown, sent: false, next: next?.preview ?? PREVIEW_ONLY };
  }
  await notMainnet(ctx);
  const signature = await execute(ctx.transport, prepared, signer);
  return { ...shown, sent: true, signature, ...(next?.done === undefined ? {} : { next: next.done }) };
}

export function sha256Of(text: string, path: string): string {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidInput([{ path, message: "give a sha256 as 64 hex digits" }]);
  }
  return hex;
}

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

export const refusedBeforeSending = (error: unknown): boolean =>
  neverLanded(error) || error instanceof LedgerError || error instanceof AgentRefusal || error instanceof InvalidInput || rpcRefused(error);
