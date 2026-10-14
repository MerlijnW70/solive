import { MAX_PRIORITY_PRICE, type Priority } from "./compute.js";
import { tokenNamed } from "./tokens.js";
import {
  ACCEPTS,
  GLOBAL_OPTIONS,
  type OPTIONS,
  type StringKey,
  SUB_ACCEPTS,
  TOKEN_SIDES,
  type Tokens,
  type Values,
} from "./arg-options.js";
import { type Address, address } from "@solana/kit";
import {
  I64_MAX,
  I64_MIN,
  isMemoUrl,
  Kind,
  kindBit,
  MEMO_URL_RULE,
  parseAmount,
  TOKEN_AMOUNT_PATTERN,
  U64_MAX,
} from "@intent-engine/core";

export class UsageError extends Error {}

export const KIND_NAMES: Record<string, Kind> = {
  swap: Kind.SwapExactIn,
  limit: Kind.LimitOrder,
  dutch: Kind.DutchAuction,
  attested: Kind.AttestedResult,
};

const PAUSE_NAMES: Record<string, number> = { none: 0, create: 1, fill: 2, all: 3 };

export function parseKinds(text: string): bigint {
  return parseKindSet(text, "kinds", false);
}

export function parseKindSet(text: string, key: string, allowNone: boolean): bigint {
  if (allowNone && text === "none") {
    return 0n;
  }
  let mask = 0n;
  for (const name of text.split(",")) {
    const kind = KIND_NAMES[name];
    if (kind === undefined) {
      throw new UsageError(
        `--${key} takes ${allowNone ? "none or " : ""}a comma list of swap, limit, dutch, attested; got ${name}`,
      );
    }
    mask |= kindBit(kind);
  }
  return mask;
}

export function parsePause(text: string, key: string): number {
  const flags = PAUSE_NAMES[text];
  if (flags === undefined) {
    throw new UsageError(`--${key} must be none, create, fill or all`);
  }
  return flags;
}

export function parseBounded(text: string, key: string, max: number, min = 0): number {
  if (!/^\d+$/.test(text) || BigInt(text) > BigInt(max) || BigInt(text) < BigInt(min)) {
    throw new UsageError(`--${key} must be an integer from ${min} to ${max}`);
  }
  return Number(text);
}

export function parseKindFees(text: string): { mask: number; bps: [number, number, number, number] } {
  const bps: [number, number, number, number] = [0, 0, 0, 0];
  let mask = 0;
  if (text === "") {
    return { mask, bps };
  }
  for (const pair of text.split(",")) {
    const [name, value] = pair.split("=");
    const kind = name === undefined ? undefined : KIND_NAMES[name];
    if (kind === undefined || value === undefined) {
      throw new UsageError(`--kind-fees takes name=bps pairs for swap, limit, dutch, attested; got ${pair}`);
    }
    if ((mask & (1 << kind)) !== 0) {
      throw new UsageError(`--kind-fees names ${name} twice`);
    }
    mask |= 1 << kind;
    bps[kind - 1] = parseBounded(value, "kind-fees", 0xffff);
  }
  return { mask, bps };
}

export const MAX_EVENT_LIMIT = 1_000;

export function parseLimit(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > MAX_EVENT_LIMIT) {
    throw new UsageError(`--limit must be an integer from 1 to ${MAX_EVENT_LIMIT}`);
  }
  return Number(text);
}

export function parseFeeBps(text: string): number {
  if (!/^\d+$/.test(text) || BigInt(text) > 65_535n) {
    throw new UsageError("--fee-bps must be an integer from 0 to 65535");
  }
  return Number(text);
}

export function noRepeats(argv: readonly string[]): void {
  const seen = new Set<string>();
  for (const arg of argv) {
    if (arg === "--") {
      return;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    const name = arg.slice(2).split("=")[0] ?? "";
    if (seen.has(name)) {
      throw new UsageError(`--${name} is given more than once`);
    }
    seen.add(name);
  }
}

export function onlyAccepted(verb: string | undefined, sub: string | undefined, values: Values): void {
  const accepted = verb === undefined ? undefined : (SUB_ACCEPTS[verb]?.[sub ?? ""] ?? ACCEPTS[verb]);
  const named = verb !== undefined && SUB_ACCEPTS[verb]?.[sub ?? ""] !== undefined ? `${verb} ${sub}` : verb;
  if (accepted === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (
      value !== undefined &&
      !accepted.includes(key as keyof typeof OPTIONS) &&
      !(GLOBAL_OPTIONS as readonly string[]).includes(key)
    ) {
      throw new UsageError(`${named} does not take --${key}`);
    }
  }
}

export function required(values: Values, key: StringKey): string {
  const value = values[key];
  if (value === undefined) {
    throw new UsageError(`missing --${key}`);
  }
  return value;
}

export function parseU64(text: string, key: string): bigint {
  if (!/^\d+$/.test(text) || BigInt(text) > U64_MAX) {
    throw new UsageError(`--${key} must be an integer from 0 to ${U64_MAX}`);
  }
  return BigInt(text);
}

export function parseI64(text: string, key: string): bigint {
  if (!/^-?\d+$/.test(text) || BigInt(text) < I64_MIN || BigInt(text) > I64_MAX) {
    throw new UsageError(`--${key} must be an integer from ${I64_MIN} to ${I64_MAX}`);
  }
  return BigInt(text);
}

export function parseAddress(text: string, key: string): Address {
  try {
    return address(text);
  } catch {
    throw new UsageError(`--${key} is not a base58 address`);
  }
}

export const u64 = (values: Values, key: StringKey) => parseU64(required(values, key), key);
export const key = (values: Values, name: StringKey) => parseAddress(required(values, name), name);

export function amountOf(values: Values, name: StringKey): string | Tokens {
  const side = TOKEN_SIDES[name];
  if (values.units === "raw" || side === undefined) {
    return u64(values, name).toString();
  }
  const text = required(values, name);
  if (!TOKEN_AMOUNT_PATTERN.test(text)) {
    throw new UsageError(`--${name} must be a token amount like 12 or 0.5`);
  }
  return { tokens: text, side };
}

export function unitsOf(values: Values): void {
  if (values.units !== undefined && values.units !== "raw" && values.units !== "tokens") {
    throw new UsageError("--units must be raw or tokens");
  }
}
export const timeOf = (values: Values, name: StringKey) => parseI64(required(values, name), name).toString();

export const optionalField = (values: Values, name: StringKey, field: string, read: (v: Values, n: StringKey) => unknown) =>
  values[name] === undefined ? {} : { [field]: read(values, name) };

export function https(text: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new UsageError(`--${key} is not a url`);
  }
  if (parsed.protocol !== "https:") {
    throw new UsageError(`--${key} must be an https url`);
  }
  return text.replace(/\/+$/, "");
}

export function mintAmounts(text: string | undefined, name: "relay-fee" | "min-profit"): ReadonlyMap<Address, bigint> {
  const amounts = new Map<Address, bigint>();
  for (const entry of text === undefined ? [] : text.split(",")) {
    const [mint, amount, ...rest] = entry.split("=");
    if (mint === undefined || amount === undefined || rest.length > 0) {
      throw new UsageError(`--${name} takes mint=amount pairs separated by commas`);
    }
    const key = parseAddress(mint.trim(), name);
    if (amounts.has(key)) {
      throw new UsageError(`--${name} names ${key} twice`);
    }
    amounts.set(key, parseU64(amount.trim(), name));
  }
  return amounts;
}

const LAMPORT_DECIMALS = 9;

export const MAX_SOL_COST_FORMAT = `--max-sol-cost is SOL above 0 with at most ${LAMPORT_DECIMALS} decimals, such as 0.01`;

export const MAX_RENT_FORMAT = `--max-rent is SOL above 0 with at most ${LAMPORT_DECIMALS} decimals, such as 0.01`;

function parseSol(text: string, format: string): bigint {
  let lamports: bigint;
  try {
    lamports = parseAmount(text, LAMPORT_DECIMALS);
  } catch {
    throw new UsageError(format);
  }
  if (lamports === 0n) {
    throw new UsageError(format);
  }
  return lamports;
}

export function parseSolCost(text: string): bigint {
  return parseSol(text, MAX_SOL_COST_FORMAT);
}

export function parseMaxRent(text: string): bigint {
  return parseSol(text, MAX_RENT_FORMAT);
}

export function parsePriority(text: string | undefined): Priority {
  if (text === undefined) {
    return 0n;
  }
  if (text === "auto") {
    return "auto";
  }
  const price = parseU64(text, "priority-fee");
  if (price > MAX_PRIORITY_PRICE) {
    throw new UsageError(
      `--priority-fee is micro-lamports per compute unit and at most ${MAX_PRIORITY_PRICE}; use auto for the recent market price`,
    );
  }
  return price;
}

const MINT_KEYS = ["input-mint", "output-mint", "mint"] as const;

function resolved(text: string, url: string): string {
  const mint = tokenNamed(text, url);
  if (mint instanceof Error) {
    throw new UsageError(mint.message);
  }
  return mint;
}

export function named(values: Values, url: string): void {
  for (const name of MINT_KEYS) {
    const text = values[name];
    if (text !== undefined) {
      values[name] = resolved(text, url);
    }
  }
  if (values.mints !== undefined) {
    values.mints = values.mints
      .split(",")
      .map((m) => resolved(m.trim(), url))
      .join(",");
  }
}

export function mintList(text: string): Address[] {
  return addressList(text, "mints");
}

export function addressList(text: string, name: "mints" | "lookup-table"): Address[] {
  const items = [...new Set(text.split(",").map((m) => m.trim()))];
  if (items.some((m) => m === "")) {
    throw new UsageError(`--${name} takes a comma list of addresses`);
  }
  return items.map((m) => parseAddress(m, name));
}

export const SHA256_NEEDED = "--sha256 must be the work's sha256 as 64 hex digits";

export function sha256Of(text: string, refusal = SHA256_NEEDED): string {
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new UsageError(refusal);
  }
  return text.toLowerCase();
}

export function memoUrlOf(text: string, key: "work-url" | "spec-url"): string {
  if (!isMemoUrl(text)) {
    throw new UsageError(`--${key} must be ${MEMO_URL_RULE}`);
  }
  return text;
}

export function noSub(sub: string | undefined): void {
  if (sub !== undefined) {
    throw new UsageError(`unexpected argument ${sub}`);
  }
}

export function outputOf(argv: readonly string[]): "json" | "text" {
  const at = argv.lastIndexOf("--output");
  const inline = argv.findLast((a) => a.startsWith("--output="));
  const value = at >= 0 ? argv[at + 1] : inline?.slice("--output=".length);
  if (value === undefined) {
    return "json";
  }
  if (value !== "json" && value !== "text") {
    throw new UsageError("--output must be json or text");
  }
  return value;
}
