import { parseArgs } from "node:util";
import { AUTO_PRICE_CAP, MAX_PRIORITY_PRICE, type Priority } from "./compute.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "./agent/create.js";
import { MANDATE_KIND_NAMES } from "./agent/mandate.js";
import { MAX_SUBMIT_WITHIN } from "./agent/signed.js";
import { DEVNET_URL, tokenNamed } from "./tokens.js";
import { type Address, address } from "@solana/kit";
import {
  type EconomicsSpec,
  I64_MAX,
  I64_MIN,
  isMemoUrl,
  Kind,
  kindBit,
  MAX_PARTNER_BPS,
  MEMO_URL_RULE,
  parseAmount,
  TOKEN_AMOUNT_PATTERN,
  U64_MAX,
} from "@intent-engine/core";
import { DELIVERY_PAGES } from "@intent-engine/client";
import { DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST } from "@intent-engine/solver";

export const DEFAULT_URL = "http://127.0.0.1:8899";

export const CLUSTERS: Readonly<Record<string, string>> = {
  localnet: DEFAULT_URL,
  devnet: DEVNET_URL,
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export const ENV_URL = "INTENT_ENGINE_URL";
export const ENV_KEYPAIR = "INTENT_ENGINE_KEYPAIR";

const SETUP_CLUSTER = "devnet";

export const WALLET_NOT_MAINNET = "mcp --wallet keeps its key in a file on this machine, so it serves devnet, testnet and localnet only";

const BALANCE_OF_ONE = "balance takes --keypair or --owner, not both";

export type Env = Readonly<Record<string, string | undefined>>;

export const GLOBAL_OPTIONS = ["output", "help"] as const;

export class UsageError extends Error {}

type Remote = { url: string; priority: Priority };

type RelaySpec = {
  keypair: string;
  maxLamports: bigint;
  maxTtl: bigint;
  perHour: number;
  hourlyLamports: bigint;
  fees: ReadonlyMap<Address, bigint>;
};

type AgentSpec = { keypair: string; hourlyLamports: bigint; owners: Address[] };

type IssueSpec = { inputMint: Address; outputMint: Address; out: bigint; in: bigint };

export const RELAY_NEEDS_FEES =
  "--relayer needs --relay-fee naming every input token it relays as mint=amount; amount may be 0, and other tokens are refused";

export const AGENT_NEEDS_OWNERS = "--agent needs --agent-owners naming every owner whose mandates this agent key may use";

export const RELAY_DEFAULT_TTL = 24 * 60 * 60;
export const RELAY_DEFAULT_HOURLY_LAMPORTS = 100_000_000n;
export const AGENT_DEFAULT_HOURLY_LAMPORTS = 50_000_000n;
export const RELAY_MAX_TTL = 365 * 24 * 60 * 60;
const RELAY_DEFAULT_PER_HOUR = 10;
const RELAY_MIN_TTL = 60;
type Keyed = Remote & { keypair: string };

export type Authority = { keypair: string; yes: boolean } | { authority: Address };

type Administered = Remote & { by: Authority };

type FlowName = "create" | "mandate-grant" | "mandate-revoke" | "mandate-use" | "approve" | "revoke-approval";

type LookupName = "list" | "mandate-show";

type ToolInput = Record<string, unknown>;

export type Side = "input" | "output";

export type Tokens = { tokens: string; side: Side };

export const TOKEN_SIDES: Partial<Record<string, Side>> = {
  "amount-in": "input",
  make: "input",
  "per-intent": "input",
  total: "input",
  "agent-fee": "input",
  "floor-in": "input",
  "relayer-fee": "input",
  "judge-fee": "input",
  amount: "input",
  "min-out": "output",
  take: "output",
  "start-out": "output",
  "end-out": "output",
  "floor-out": "output",
};

type ConfigChange = {
  guardian: Address | undefined;
  feeRecipient: Address | undefined;
  feeBps: number | undefined;
  enabledKinds: bigint | undefined;
  fillDisabledKinds: bigint | undefined;
};

export type Command =
  | { name: "pda"; owner: Address; nonce: bigint }
  | { name: "hash"; artifact: string }
  | (Remote & { name: "show-config" })
  | (Remote & { name: "domain" })
  | (Remote & { name: "setup"; keypair: string | undefined })
  | (Remote & { name: "balance"; keypair: string | undefined; owner: Address | undefined; mints: Address[] | null })
  | (Remote & { name: "mcp"; relay: RelaySpec | undefined; agent: AgentSpec | undefined; wallet: WalletLimits | null })
  | (Remote & { name: "show-intent"; owner: Address; nonce: bigint })
  | (Remote & { name: "quote"; owner: Address; nonce: bigint; at: bigint | undefined })
  | (Keyed & { name: "cancel"; yes: boolean; nonce: bigint; close: boolean })
  | (Keyed & { name: "expire"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "close"; yes: boolean; owner: Address; nonce: bigint })
  | (Keyed & { name: "advance-nonce"; base: bigint })
  | (Keyed & { name: "advance-epoch" })
  | (Administered & {
      name: "init-config";
      guardian: Address;
      feeRecipient: Address;
      feeBps: number;
      enabledKinds: bigint;
      paused: number;
    })
  | (Administered & { name: "raise-pause" | "lower-pause"; flags: number })
  | (Administered & { name: "set-economics"; economics: EconomicsSpec })
  | (Administered & { name: "update-config"; change: ConfigChange })
  | (Administered & { name: "propose-admin"; pendingAdmin: Address })
  | (Administered & { name: "accept-admin" })
  | (Keyed & {
      name: "solve";
      jupiter: string | undefined;
      issue: IssueSpec[];
      jito: string | undefined;
      tipLamports: bigint;
      minProfit: ReadonlyMap<Address, bigint>;
      maxFeeBps: number;
      maxSolCost: bigint;
      maxRent: bigint;
      slippageBps: number;
      routeProgram: Address | undefined;
      lookupTables: Address[];
      watch: number | null;
    })
  | (Keyed & { name: "crank"; dryRun: boolean; fundAccounts: boolean })
  | (Remote & { name: "events"; limit: number })
  | (Remote & { name: "jobs"; attestor: Address | undefined })
  | (Keyed & { name: "deliver"; yes: boolean; intent: Address; sha256: string; workUrl: string })
  | (Remote & { name: "deliveries"; attestor: Address; intent: Address; maxPages: number })
  | (Remote & { name: "receipt"; owner: Address; nonce: bigint; sha256: string | undefined })
  | (Keyed & {
      name: "judge";
      yes: boolean;
      owner: Address;
      nonce: bigint;
      spec: string;
      artifact: string;
      run: string;
      payTo: Address | undefined;
      result: bigint | undefined;
      timeout: number;
      verdict: string | undefined;
      maxPages: number;
    })
  | (Keyed & { name: "flow"; flow: FlowName; yes: boolean; input: ToolInput })
  | (Remote & { name: "lookup"; lookup: LookupName; keypair: string | undefined; input: ToolInput })
  | (Keyed & { name: "signed-prepare"; yes: boolean; out: string; input: ToolInput })
  | (Keyed & { name: "signed-submit"; yes: boolean; file: string })
  | { name: "help"; verb: string | undefined }
  | { name: "version" }
  | (Remote & { name: "follow"; limit: number; interval: number })
  | (Remote & { name: "treasury"; mints: Address[] | null; create: boolean; keypair: string | undefined; yes: boolean })
  | (Remote & { name: "solver-table"; solver: Address; mints: Address[] });

const OPTIONS = {
  url: { type: "string" },
  keypair: { type: "string" },
  relayer: { type: "string" },
  agent: { type: "string" },
  wallet: { type: "boolean" },
  "wallet-per-trade": { type: "string" },
  "wallet-per-hour": { type: "string" },
  "relay-max-lamports": { type: "string" },
  "relay-max-ttl": { type: "string" },
  "relay-per-hour": { type: "string" },
  "relay-hourly-lamports": { type: "string" },
  "relay-fee": { type: "string" },
  "priority-fee": { type: "string" },
  authority: { type: "string" },
  "fill-disabled": { type: "string" },
  "new-admin": { type: "string" },
  "agent-hourly-lamports": { type: "string" },
  "agent-owners": { type: "string" },
  owner: { type: "string" },
  nonce: { type: "string" },
  at: { type: "string" },
  base: { type: "string" },
  "input-mint": { type: "string" },
  "output-mint": { type: "string" },
  "expires-at": { type: "string" },
  "amount-in": { type: "string" },
  "min-out": { type: "string" },
  make: { type: "string" },
  take: { type: "string" },
  guardian: { type: "string" },
  "fee-recipient": { type: "string" },
  "fee-bps": { type: "string" },
  kinds: { type: "string" },
  flags: { type: "string" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
  follow: { type: "boolean" },
  watch: { type: "boolean" },
  output: { type: "string" },
  interval: { type: "string" },
  "expires-in": { type: "string" },
  "start-out": { type: "string" },
  "end-out": { type: "string" },
  "start-at": { type: "string" },
  "end-at": { type: "string" },
  "min-result": { type: "string" },
  "max-result": { type: "string" },
  attestor: { type: "string" },
  "per-intent": { type: "string" },
  total: { type: "string" },
  "max-intents": { type: "string" },
  "max-ttl": { type: "string" },
  "valid-for": { type: "string" },
  "floor-out": { type: "string" },
  "floor-in": { type: "string" },
  "agent-fee": { type: "string" },
  id: { type: "string" },
  mint: { type: "string" },
  amount: { type: "string" },
  out: { type: "string" },
  file: { type: "string" },
  "submit-within": { type: "string" },
  "relayer-fee": { type: "string" },
  units: { type: "string" },
  "fund-accounts": { type: "boolean" },
  limit: { type: "string" },
  bounty: { type: "string" },
  "create-fee": { type: "string" },
  "kind-fees": { type: "string" },
  "partner-cut": { type: "string" },
  partner: { type: "string" },
  jupiter: { type: "string" },
  jito: { type: "string" },
  tip: { type: "string" },
  "min-profit": { type: "string" },
  issue: { type: "string" },
  "max-fee-bps": { type: "string" },
  "max-sol-cost": { type: "string" },
  "max-rent": { type: "string" },
  "slippage-bps": { type: "string" },
  "route-program": { type: "string" },
  "lookup-table": { type: "string" },
  solver: { type: "string" },
  "partner-bps": { type: "string" },
  mints: { type: "string" },
  create: { type: "boolean" },
  intent: { type: "string" },
  sha256: { type: "string" },
  "work-url": { type: "string" },
  spec: { type: "string" },
  artifact: { type: "string" },
  run: { type: "string" },
  "pay-to": { type: "string" },
  timeout: { type: "string" },
  verdict: { type: "string" },
  "max-pages": { type: "string" },
  "spec-hash": { type: "string" },
  "judge-fee": { type: "string" },
  "spec-url": { type: "string" },
  result: { type: "string" },
  close: { type: "boolean" },
} as const;

const KIND_NAMES: Record<string, Kind> = {
  swap: Kind.SwapExactIn,
  limit: Kind.LimitOrder,
  dutch: Kind.DutchAuction,
  attested: Kind.AttestedResult,
};

const PAUSE_NAMES: Record<string, number> = { none: 0, create: 1, fill: 2, all: 3 };

export function parseKinds(text: string): bigint {
  return parseKindSet(text, "kinds", false);
}

function parseKindSet(text: string, key: string, allowNone: boolean): bigint {
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

function parseBounded(text: string, key: string, max: number, min = 0): number {
  if (!/^\d+$/.test(text) || BigInt(text) > BigInt(max) || BigInt(text) < BigInt(min)) {
    throw new UsageError(`--${key} must be an integer from ${min} to ${max}`);
  }
  return Number(text);
}

function parseKindFees(text: string): { mask: number; bps: [number, number, number, number] } {
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

type Flag = "dry-run" | "fund-accounts" | "yes" | "help" | "version" | "follow" | "create" | "wallet" | "watch" | "close";
type StringKey = Exclude<keyof typeof OPTIONS, Flag>;
type Values = { [K in StringKey]?: string | undefined } & { [K in Flag]?: boolean | undefined };

const EXPIRY = ["expires-at", "expires-in"] as const;

const ORDER = [
  "amount-in",
  "min-out",
  "make",
  "take",
  "start-out",
  "end-out",
  "start-at",
  "end-at",
  "min-result",
  "max-result",
  "attestor",
] as const;

const MANDATE_ORDER = ORDER.filter((o) => o !== "min-result" && o !== "max-result" && o !== "attestor");

export const MANDATE_USE_KINDS = "a mandate covers swap, limit and dutch orders; name one of those";

export const ACCEPTS: Record<string, readonly (keyof typeof OPTIONS)[]> = {
  setup: ["url", "keypair"],
  balance: ["url", "keypair", "owner", "mints"],
  pda: ["owner", "nonce"],
  hash: ["artifact"],
  show: ["url", "owner", "nonce"],
  domain: ["url"],
  mcp: [
    "url",
    "priority-fee",
    "relayer",
    "relay-max-lamports",
    "relay-max-ttl",
    "relay-per-hour",
    "relay-hourly-lamports",
    "relay-fee",
    "agent",
    "agent-hourly-lamports",
    "agent-owners",
    "wallet",
    "wallet-per-trade",
    "wallet-per-hour",
  ],
  quote: ["url", "owner", "nonce", "at"],
  cancel: ["url", "priority-fee", "keypair", "yes", "nonce", "close"],
  expire: ["url", "priority-fee", "keypair", "yes", "owner", "nonce"],
  close: ["url", "priority-fee", "keypair", "yes", "owner", "nonce"],
  "advance-nonce": ["url", "priority-fee", "keypair", "base"],
  "advance-epoch": ["url", "priority-fee", "keypair"],
  "init-config": ["url", "priority-fee", "keypair", "authority", "yes", "guardian", "fee-recipient", "fee-bps", "kinds", "flags"],
  "raise-pause": ["url", "priority-fee", "keypair", "authority", "yes", "flags"],
  "set-economics": ["url", "priority-fee", "keypair", "authority", "yes", "bounty", "create-fee", "kind-fees", "partner-cut"],
  "update-config": [
    "url",
    "priority-fee",
    "keypair",
    "authority",
    "yes",
    "guardian",
    "fee-recipient",
    "fee-bps",
    "kinds",
    "fill-disabled",
  ],
  "propose-admin": ["url", "priority-fee", "keypair", "authority", "yes", "new-admin"],
  "accept-admin": ["url", "priority-fee", "keypair", "authority", "yes"],
  solve: ["url", "priority-fee", "keypair", "jupiter", "issue", "jito", "tip", "min-profit", "max-fee-bps", "max-sol-cost", "max-rent", "slippage-bps", "route-program", "lookup-table", "watch", "interval"],
  "solver-table": ["url", "solver", "mints"],
  "lower-pause": ["url", "priority-fee", "keypair", "authority", "yes", "flags"],
  events: ["url", "limit", "follow", "interval"],
  jobs: ["url", "attestor"],
  deliver: ["url", "priority-fee", "keypair", "yes", "intent", "sha256", "work-url"],
  deliveries: ["url", "attestor", "intent", "max-pages"],
  receipt: ["url", "owner", "nonce", "sha256"],
  judge: ["url", "priority-fee", "keypair", "yes", "owner", "nonce", "spec", "artifact", "run", "pay-to", "result", "timeout", "verdict", "max-pages"],
  crank: ["url", "priority-fee", "keypair", "dry-run", "fund-accounts"],
  treasury: ["url", "priority-fee", "keypair", "yes", "mints", "create"],
  create: [
    "url",
    "priority-fee",
    "keypair",
    "yes",
    "nonce",
    "input-mint",
    "output-mint",
    ...EXPIRY,
    ...ORDER,
    "spec-hash",
    "judge-fee",
    "spec-url",
    "pay-to",
    "partner",
    "partner-bps",
    "units",
  ],
  list: ["url", "keypair", "owner"],
  mandate: [
    "url",
    "priority-fee",
    "keypair",
    "yes",
    "owner",
    "agent",
    "id",
    "input-mint",
    "output-mint",
    "kinds",
    "per-intent",
    "total",
    "max-intents",
    "max-ttl",
    "valid-for",
    "floor-out",
    "floor-in",
    "partner",
    "partner-bps",
    "agent-fee",
    "nonce",
    ...EXPIRY,
    ...ORDER,
    "units",
  ],
  approve: ["url", "priority-fee", "keypair", "yes", "mint", "amount", "units"],
  "revoke-approval": ["url", "priority-fee", "keypair", "yes", "mint"],
  signed: [
    "url",
    "keypair",
    "yes",
    "out",
    "file",
    "nonce",
    "input-mint",
    "output-mint",
    "submit-within",
    "relayer-fee",
    ...EXPIRY,
    ...ORDER,
    "partner",
    "partner-bps",
    "units",
  ],
};

export const SUB_ACCEPTS: Record<string, Record<string, readonly (keyof typeof OPTIONS)[]>> = {
  mandate: {
    grant: [
      "url",
      "priority-fee",
      "keypair",
      "yes",
      "agent",
      "id",
      "input-mint",
      "output-mint",
      "kinds",
      "per-intent",
      "total",
      "max-intents",
      "max-ttl",
      "valid-for",
      "floor-out",
      "floor-in",
      "partner",
      "partner-bps",
      "agent-fee",
      "units",
    ],
    show: ["url", "keypair", "agent", "id", "owner"],
    revoke: ["url", "priority-fee", "keypair", "yes", "agent", "id"],
    use: ["url", "priority-fee", "keypair", "yes", "owner", "id", "nonce", ...EXPIRY, ...MANDATE_ORDER, "units"],
  },
  signed: {
    prepare: [
      "url",
      "keypair",
      "yes",
      "out",
      "nonce",
      "input-mint",
      "output-mint",
      "submit-within",
      "relayer-fee",
      ...EXPIRY,
      ...ORDER,
      "partner",
      "partner-bps",
      "units",
    ],
    submit: ["url", "keypair", "yes", "file"],
  },
};

function noRepeats(argv: readonly string[]): void {
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

function onlyAccepted(verb: string | undefined, sub: string | undefined, values: Values): void {
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

function required(values: Values, key: StringKey): string {
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

function parseAddress(text: string, key: string): Address {
  try {
    return address(text);
  } catch {
    throw new UsageError(`--${key} is not a base58 address`);
  }
}

const u64 = (values: Values, key: StringKey) => parseU64(required(values, key), key);
const key = (values: Values, name: StringKey) => parseAddress(required(values, name), name);

function amountOf(values: Values, name: StringKey): string | Tokens {
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

function unitsOf(values: Values): void {
  if (values.units !== undefined && values.units !== "raw" && values.units !== "tokens") {
    throw new UsageError("--units must be raw or tokens");
  }
}
const timeOf = (values: Values, name: StringKey) => parseI64(required(values, name), name).toString();

const ORDER_FIELDS: Record<string, readonly StringKey[]> = {
  swap: ["amount-in", "min-out"],
  limit: ["make", "take"],
  dutch: ["amount-in", "start-out", "end-out", "start-at", "end-at"],
  attested: ["amount-in", "min-result", "max-result", "attestor"],
};

export function order(kind: string | undefined, values: Values): ToolInput {
  const fields = kind === undefined ? undefined : ORDER_FIELDS[kind];
  if (fields === undefined) {
    throw new UsageError("name the order kind: swap, limit, dutch or attested");
  }
  for (const name of ORDER) {
    if (values[name] !== undefined && !fields.includes(name)) {
      throw new UsageError(`a ${kind} order does not take --${name}`);
    }
  }
  switch (kind) {
    case "swap":
      return { kind, amount_in: amountOf(values, "amount-in"), min_out: amountOf(values, "min-out") };
    case "limit":
      return { kind, make_amount: amountOf(values, "make"), take_amount: amountOf(values, "take") };
    case "dutch":
      return {
        kind,
        amount_in: amountOf(values, "amount-in"),
        start_out: amountOf(values, "start-out"),
        end_out: amountOf(values, "end-out"),
        start_time: timeOf(values, "start-at"),
        end_time: timeOf(values, "end-at"),
      };
    default:
      return {
        kind,
        amount_in: amountOf(values, "amount-in"),
        min_result: amountOf(values, "min-result"),
        max_result: amountOf(values, "max-result"),
        attestor: key(values, "attestor"),
      };
  }
}

export function expiry(values: Values): ToolInput {
  if ((values["expires-at"] === undefined) === (values["expires-in"] === undefined)) {
    throw new UsageError("give exactly one of --expires-at or --expires-in");
  }
  return values["expires-at"] === undefined
    ? { expires_in: parseBounded(required(values, "expires-in"), "expires-in", MAX_EXPIRES_IN, MIN_EXPIRES_IN) }
    : { expires_at: timeOf(values, "expires-at") };
}

function partner(values: Values): ToolInput {
  if (values.partner === undefined && values["partner-bps"] === undefined) {
    return {};
  }
  return {
    partner: {
      account: key(values, "partner"),
      bps: parseBounded(required(values, "partner-bps"), "partner-bps", MAX_PARTNER_BPS),
    },
  };
}

const optionalField = (values: Values, name: StringKey, field: string, read: (v: Values, n: StringKey) => unknown) =>
  values[name] === undefined ? {} : { [field]: read(values, name) };

function terms(kind: string | undefined, values: Values): ToolInput {
  return {
    input_mint: key(values, "input-mint"),
    output_mint: key(values, "output-mint"),
    order: order(kind, values),
    ...expiry(values),
    ...optionalField(values, "nonce", "nonce", amountOf),
    ...partner(values),
  };
}

function grant(values: Values): ToolInput {
  const kinds = required(values, "kinds").split(",");
  for (const name of kinds) {
    if (!(MANDATE_KIND_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(`--kinds takes a comma list of swap, limit, dutch; got ${name}`);
    }
  }
  return {
    agent: key(values, "agent"),
    input_mint: key(values, "input-mint"),
    output_mint: key(values, "output-mint"),
    kinds,
    per_intent: amountOf(values, "per-intent"),
    total: amountOf(values, "total"),
    max_intents: parseBounded(required(values, "max-intents"), "max-intents", 0xffff_ffff),
    max_ttl: parseBounded(required(values, "max-ttl"), "max-ttl", MAX_EXPIRES_IN, MIN_EXPIRES_IN),
    valid_for: parseBounded(required(values, "valid-for"), "valid-for", MAX_EXPIRES_IN, MIN_EXPIRES_IN),
    floor: { out: amountOf(values, "floor-out"), in: amountOf(values, "floor-in") },
    ...optionalField(values, "id", "id", amountOf),
    ...partner(values),
    ...optionalField(values, "agent-fee", "agent_fee", amountOf),
  };
}

function mandate(sub: string | undefined, kind: string | undefined, remote: Remote, values: Values): Command {
  const flow = (name: FlowName, input: ToolInput): Command => ({
    name: "flow",
    ...remote,
    flow: name,
    keypair: required(values, "keypair"),
    yes: values.yes === true,
    input,
  });
  const ref = () => ({ agent: key(values, "agent"), ...optionalField(values, "id", "id", amountOf) });
  if (sub !== "use") {
    noSub(kind);
  }
  switch (sub) {
    case "grant":
      return flow("mandate-grant", grant(values));
    case "revoke":
      return flow("mandate-revoke", ref());
    case "show":
      return {
        name: "lookup",
        ...remote,
        lookup: "mandate-show",
        keypair: values.keypair,
        input: { ...ref(), ...optionalField(values, "owner", "owner", key) },
      };
    case "use":
      if (kind === "attested") {
        throw new UsageError(MANDATE_USE_KINDS);
      }
      return flow("mandate-use", {
        owner: key(values, "owner"),
        order: order(kind, values),
        ...expiry(values),
        ...optionalField(values, "id", "id", amountOf),
        ...optionalField(values, "nonce", "nonce", amountOf),
      });
    default:
      throw new UsageError("mandate needs grant, show, revoke or use");
  }
}

function https(text: string, key: string): string {
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

function relaySpec(values: Values): RelaySpec | undefined {
  const policy = [
    values["relay-max-lamports"],
    values["relay-max-ttl"],
    values["relay-per-hour"],
    values["relay-hourly-lamports"],
    values["relay-fee"],
  ];
  if (values.relayer === undefined) {
    if (policy.some((v) => v !== undefined)) {
      throw new UsageError("the --relay-* limits need --relayer");
    }
    return undefined;
  }
  if (values["relay-fee"] === undefined) {
    throw new UsageError(RELAY_NEEDS_FEES);
  }
  const maxTtl = parseBounded(values["relay-max-ttl"] ?? String(RELAY_DEFAULT_TTL), "relay-max-ttl", RELAY_MAX_TTL);
  const perHour = parseBounded(values["relay-per-hour"] ?? String(RELAY_DEFAULT_PER_HOUR), "relay-per-hour", 3_600);
  if (maxTtl < RELAY_MIN_TTL || perHour < 1) {
    throw new UsageError(`--relay-max-ttl must be at least ${RELAY_MIN_TTL} and --relay-per-hour at least 1`);
  }
  return {
    keypair: values.relayer,
    maxLamports: values["relay-max-lamports"] === undefined ? 0n : u64(values, "relay-max-lamports"),
    maxTtl: BigInt(maxTtl),
    perHour,
    hourlyLamports:
      values["relay-hourly-lamports"] === undefined
        ? RELAY_DEFAULT_HOURLY_LAMPORTS
        : u64(values, "relay-hourly-lamports"),
    fees: mintAmounts(values["relay-fee"], "relay-fee"),
  };
}

function mintAmounts(text: string | undefined, name: "relay-fee" | "min-profit"): ReadonlyMap<Address, bigint> {
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

export type WalletLimits = { perTrade: ReadonlyMap<Address, string>; perHour: ReadonlyMap<Address, string> };

export const WALLET_LIMITS_NEED_WALLET = "--wallet-per-trade and --wallet-per-hour need --wallet";

const wholeTokens = (key: string) => `--${key} takes token=amount pairs separated by commas, such as SOL=0.1,TEST=20`;

function tokenAmounts(text: string | undefined, key: "wallet-per-trade" | "wallet-per-hour", url: string): ReadonlyMap<Address, string> {
  const amounts = new Map<Address, string>();
  for (const entry of text === undefined ? [] : text.split(",")) {
    const [name, amount, ...rest] = entry.split("=");
    if (name === undefined || amount === undefined || rest.length > 0 || !TOKEN_AMOUNT_PATTERN.test(amount.trim())) {
      throw new UsageError(wholeTokens(key));
    }
    const mint = tokenNamed(name.trim(), url);
    if (mint instanceof Error) {
      throw new UsageError(`--${key}: ${mint.message}`);
    }
    const parsed = parseAddress(mint, key);
    if (amounts.has(parsed)) {
      throw new UsageError(`--${key} names ${name.trim()} twice`);
    }
    amounts.set(parsed, amount.trim());
  }
  return amounts;
}

function walletLimits(values: Values, url: string): WalletLimits | null {
  if (values.wallet !== true) {
    if (values["wallet-per-trade"] !== undefined || values["wallet-per-hour"] !== undefined) {
      throw new UsageError(WALLET_LIMITS_NEED_WALLET);
    }
    return null;
  }
  return {
    perTrade: tokenAmounts(values["wallet-per-trade"], "wallet-per-trade", url),
    perHour: tokenAmounts(values["wallet-per-hour"], "wallet-per-hour", url),
  };
}

function agentSpec(values: Values): AgentSpec | undefined {
  if (values.agent === undefined) {
    if (values["agent-hourly-lamports"] !== undefined || values["agent-owners"] !== undefined) {
      throw new UsageError("the --agent-* limits need --agent");
    }
    return undefined;
  }
  const owners = values["agent-owners"];
  if (owners === undefined) {
    throw new UsageError(AGENT_NEEDS_OWNERS);
  }
  return {
    keypair: values.agent,
    hourlyLamports:
      values["agent-hourly-lamports"] === undefined
        ? AGENT_DEFAULT_HOURLY_LAMPORTS
        : u64(values, "agent-hourly-lamports"),
    owners: owners.split(",").map((o) => parseAddress(o.trim(), "agent-owners")),
  };
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

export const solveFeeAboveCap = `solve takes a --priority-fee of at most ${AUTO_PRICE_CAP} micro-lamports per compute unit, the cap of auto`;

export const zeroProfit = (mint: string): string => `--min-profit for ${mint} must be above 0, or every fill of it can lose SOL`;

function profitFloors(text: string): ReadonlyMap<Address, bigint> {
  const floors = mintAmounts(text, "min-profit");
  for (const [mint, floor] of floors) {
    if (floor === 0n) {
      throw new UsageError(zeroProfit(mint));
    }
  }
  return floors;
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

function authorityOf(values: Values): Authority {
  if (values.keypair !== undefined && values.authority !== undefined) {
    throw new UsageError("pass --keypair to sign and send, or --authority to print an unsigned transaction, not both");
  }
  if (values.authority !== undefined) {
    if (values.yes === true) {
      throw new UsageError("--yes signs and sends with --keypair; --authority only prints an unsigned transaction");
    }
    return { authority: key(values, "authority") };
  }
  return { keypair: required(values, "keypair"), yes: values.yes === true };
}

function configChange(values: Values): ConfigChange {
  const change = {
    guardian: values.guardian === undefined ? undefined : key(values, "guardian"),
    feeRecipient: values["fee-recipient"] === undefined ? undefined : key(values, "fee-recipient"),
    feeBps: values["fee-bps"] === undefined ? undefined : parseFeeBps(values["fee-bps"]),
    enabledKinds: values.kinds === undefined ? undefined : parseKinds(values.kinds),
    fillDisabledKinds:
      values["fill-disabled"] === undefined ? undefined : parseKindSet(values["fill-disabled"], "fill-disabled", true),
  };
  if (Object.values(change).every((v) => v === undefined)) {
    throw new UsageError("update-config needs at least one of --guardian, --fee-recipient, --fee-bps, --kinds, --fill-disabled");
  }
  return change;
}

const MINT_KEYS = ["input-mint", "output-mint", "mint"] as const;

function resolved(text: string, url: string): string {
  const mint = tokenNamed(text, url);
  if (mint instanceof Error) {
    throw new UsageError(mint.message);
  }
  return mint;
}

function named(values: Values, url: string): void {
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

function mintList(text: string): Address[] {
  return addressList(text, "mints");
}

export const ISSUE_FORMAT = "--issue takes <input mint>:<output mint>=<out>/<in> entries separated by commas";
export const ONE_MARKET = "solve needs exactly one of --jupiter or --issue";
export const ISSUE_ALONE = "--issue mints the output itself, so --slippage-bps and --route-program do not apply";

function issues(text: string): IssueSpec[] {
  const routes: IssueSpec[] = [];
  for (const entry of text.split(",")) {
    const match = /^([^:=/]+):([^:=/]+)=([^:=/]+)\/([^:=/]+)$/.exec(entry.trim());
    if (match === null) {
      throw new UsageError(ISSUE_FORMAT);
    }
    const [, input = "", output = "", out = "", per = ""] = match;
    const route = {
      inputMint: parseAddress(input.trim(), "issue"),
      outputMint: parseAddress(output.trim(), "issue"),
      out: parseU64(out.trim(), "issue"),
      in: parseU64(per.trim(), "issue"),
    };
    if (route.out === 0n || route.in === 0n) {
      throw new UsageError("--issue rates must be positive on both sides");
    }
    if (routes.some((r) => r.inputMint === route.inputMint && r.outputMint === route.outputMint)) {
      throw new UsageError(`--issue names ${route.inputMint}:${route.outputMint} twice`);
    }
    routes.push(route);
  }
  return routes;
}

function market(values: Values): { jupiter: string | undefined; issue: IssueSpec[] } {
  if ((values.jupiter === undefined) === (values.issue === undefined)) {
    throw new UsageError(ONE_MARKET);
  }
  if (values.issue === undefined) {
    return { jupiter: https(required(values, "jupiter"), "jupiter"), issue: [] };
  }
  if (values["slippage-bps"] !== undefined || values["route-program"] !== undefined) {
    throw new UsageError(ISSUE_ALONE);
  }
  return { jupiter: undefined, issue: issues(values.issue) };
}

function addressList(text: string, name: "mints" | "lookup-table"): Address[] {
  const items = [...new Set(text.split(",").map((m) => m.trim()))];
  if (items.some((m) => m === "")) {
    throw new UsageError(`--${name} takes a comma list of addresses`);
  }
  return items.map((m) => parseAddress(m, name));
}

export const TREASURY_CREATE_NEEDS_MINTS =
  "--create needs --mints naming the tokens to open treasury accounts for; anyone can open intents in any token, so the list must be yours";

function treasury(remote: Remote, values: Values): Command {
  const create = values.create === true;
  if (values.yes === true && !create) {
    throw new UsageError("--yes only applies with --create");
  }
  if (create && values.mints === undefined) {
    throw new UsageError(TREASURY_CREATE_NEEDS_MINTS);
  }
  return {
    name: "treasury",
    ...remote,
    mints: values.mints === undefined ? null : mintList(values.mints),
    create,
    keypair: create ? required(values, "keypair") : values.keypair,
    yes: values.yes === true,
  };
}

export const SHA256_NEEDED = "--sha256 must be the work's sha256 as 64 hex digits";

export const SPEC_HASH_FORMAT = "--spec-hash must be the spec's sha256 as 64 hex digits";
export const needsSpecHash = (option: string) => `--${option} needs --spec-hash, which makes the attested escrow a proof escrow`;

function sha256Of(text: string, refusal = SHA256_NEEDED): string {
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new UsageError(refusal);
  }
  return text.toLowerCase();
}

function memoUrlOf(text: string, key: "work-url" | "spec-url"): string {
  if (!isMemoUrl(text)) {
    throw new UsageError(`--${key} must be ${MEMO_URL_RULE}`);
  }
  return text;
}

const PROOF_OPTIONS = ["spec-hash", "judge-fee", "spec-url"] as const;

function createTerms(kind: string | undefined, values: Values): ToolInput {
  const base = terms(kind, values);
  const payTo = optionalField(values, "pay-to", "pay_to", key);
  if (kind !== "attested") {
    const given = PROOF_OPTIONS.find((name) => values[name] !== undefined);
    if (given !== undefined) {
      throw new UsageError(`a ${kind} order does not take --${given}`);
    }
    return { ...base, ...payTo };
  }
  const specHash = values["spec-hash"];
  if (specHash === undefined) {
    const given = PROOF_OPTIONS.find((name) => values[name] !== undefined);
    if (given !== undefined) {
      throw new UsageError(needsSpecHash(given));
    }
    return { ...base, ...payTo };
  }
  return {
    ...base,
    order: {
      ...(base["order"] as ToolInput),
      spec_hash: sha256Of(specHash, SPEC_HASH_FORMAT),
      ...optionalField(values, "judge-fee", "judge_fee", amountOf),
    },
    ...optionalField(values, "spec-url", "spec_url", (v, n) => memoUrlOf(required(v, n), "spec-url")),
    ...payTo,
  };
}

export const MAX_DELIVERY_PAGES = 100_000;

function maxPagesOf(values: Values): number {
  return parseBounded(values["max-pages"] ?? String(DELIVERY_PAGES), "max-pages", MAX_DELIVERY_PAGES, 1);
}

export const JUDGE_TIMEOUT = 600;
export const MAX_JUDGE_TIMEOUT = 86_400;
export const RUN_NEEDED = "--run must name the command that checks the artifact";

function runOf(text: string): string {
  if (text.trim() === "") {
    throw new UsageError(RUN_NEEDED);
  }
  return text;
}

function noSub(sub: string | undefined): void {
  if (sub !== undefined) {
    throw new UsageError(`unexpected argument ${sub}`);
  }
}

export function clusterUrl(text: string): string {
  return CLUSTERS[text] ?? text;
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

export const MAX_FOLLOW_INTERVAL = 3_600;
export const WATCH_INTERVAL = 5;

export const COMMANDS = "setup | balance | pda | domain | mcp | show config | show intent | quote | cancel | expire | close | advance-nonce | advance-epoch | create swap|limit|dutch|attested | list | mandate grant|show|revoke|use <kind> | approve | revoke-approval | signed prepare <kind>|submit | init-config | update-config | set-economics | propose-admin | accept-admin | solve | raise-pause | lower-pause | crank | treasury | solver-table | events | jobs | deliver | deliveries | receipt | judge | hash | version | help [command]";

export const USAGE = `usage: ${COMMANDS}`;

const MANDATE_ORDER_SHAPE = "(--amount-in --min-out | --make --take | --amount-in --start-out --end-out --start-at --end-at)";

const ORDER_SHAPE = "(--amount-in --min-out | --make --take | --amount-in --start-out --end-out --start-at --end-at | --amount-in --min-result --max-result --attestor)";

const PARTNER_SHAPE = "[--partner <address> --partner-bps <n>]";

export const SHAPES: Readonly<Record<string, string>> = {
  setup: "[--url <cluster>] [--keypair <file>]",
  balance: "[--keypair <file> | --owner <address>] [--mints <mint,...>]",
  pda: "--owner <address> --nonce <n>",
  hash: "--artifact <file or directory>",
  show: "config | intent --owner <address> --nonce <n>",
  domain: "",
  mcp: "[--wallet [--wallet-per-trade <token=amount,...>] [--wallet-per-hour <token=amount,...>]] [--relayer <keypair> --relay-fee <mint=amount,...> [--relay-max-lamports] [--relay-max-ttl] [--relay-per-hour] [--relay-hourly-lamports]] [--agent <keypair> --agent-owners <address,...> [--agent-hourly-lamports]]",
  quote: "--owner <address> --nonce <n> [--at <unix>]",
  cancel: "--keypair <file> --nonce <n> [--close] [--yes]",
  expire: "--keypair <file> --owner <address> --nonce <n> [--yes]",
  close: "--keypair <file> --owner <address> --nonce <n> [--yes]",
  "advance-nonce": "--keypair <file> --base <n>",
  "advance-epoch": "--keypair <file>",
  "init-config": "(--keypair <file> [--yes] | --authority <address>) --guardian --fee-recipient --fee-bps --kinds [--flags create|fill|all]",
  "update-config": "(--keypair <file> [--yes] | --authority <address>) and any of --guardian --fee-recipient --fee-bps --kinds --fill-disabled",
  "propose-admin": "(--keypair <file> [--yes] | --authority <address>) --new-admin <address>",
  "accept-admin": "(--keypair <file> [--yes] | --authority <address>)",
  "raise-pause": "(--keypair <file> [--yes] | --authority <address>) --flags create|fill|all",
  "lower-pause": "(--keypair <file> [--yes] | --authority <address>) --flags create|fill|all",
  "set-economics": "(--keypair <file> [--yes] | --authority <address>) --bounty --create-fee [--kind-fees] [--partner-cut]",
  solve: "--keypair <file> (--jupiter <url> | --issue <input mint>:<output mint>=<out>/<in>,...) --min-profit <output mint=raw,...> [--priority-fee <micro-lamports|auto>] [--max-fee-bps <n>] [--max-sol-cost <SOL>] [--max-rent <SOL>] [--slippage-bps <n>] [--jito <url> [--tip <lamports>]] [--route-program <program the aggregator swaps through>] [--lookup-table <address,...>] [--watch [--interval <seconds>]]",
  "solver-table": "--solver <address> --mints <mint,...>",
  crank: "--keypair <file> [--dry-run] [--fund-accounts]",
  treasury: "[--mints <mint,...>] [--create --mints <mint,...> --keypair <payer file> [--yes]]",
  events: "[--limit <n>] [--follow [--interval <seconds>]]",
  jobs: "[--attestor <address>]",
  deliver: "--keypair <worker file> --intent <address> --sha256 <64 hex> --work-url <https url> [--yes]",
  deliveries: "--attestor <address> --intent <address> [--max-pages <n>]",
  receipt: "--owner <address> --nonce <n> [--sha256 <64 hex>]",
  judge: "--keypair <judge file> --owner <address> --nonce <n> --spec <file> --artifact <file or directory> --run <command> [--pay-to <wallet>] [--result <n>] [--timeout <seconds>] [--verdict <file>] [--max-pages <n>] [--yes]",
  create: `swap|limit|dutch|attested --keypair <file> --input-mint --output-mint (--expires-at | --expires-in) ${ORDER_SHAPE} [--nonce <n>] [--pay-to <wallet>] ${PARTNER_SHAPE} [--units tokens|raw] [--yes]; attested takes [--spec-hash <64 hex> [--judge-fee <amount>] [--spec-url <https url>]] to make a proof escrow`,
  list: "--owner <address> or --keypair <file>; --owner wins when both are given",
  mandate: `grant --keypair <file> --agent --input-mint --output-mint --kinds --per-intent --total --max-intents --max-ttl --valid-for --floor-out --floor-in [--agent-fee] ${PARTNER_SHAPE} [--id] [--units tokens|raw] [--yes] | show --agent (--owner <address> | --keypair <file>) [--id] | revoke --keypair <file> --agent [--id] [--yes] | use swap|limit|dutch --keypair <file> --owner (--expires-at | --expires-in) ${MANDATE_ORDER_SHAPE} [--id] [--nonce <n>] [--units tokens|raw] [--yes]`,
  approve: "--keypair <file> --mint <mint> --amount <amount> [--units tokens|raw] [--yes]",
  "revoke-approval": "--keypair <file> --mint <mint> [--yes]",
  signed: `prepare swap|limit|dutch|attested --keypair <file> --out <file> --input-mint --output-mint (--expires-at | --expires-in) ${ORDER_SHAPE} [--nonce <n>] [--submit-within <seconds>] [--relayer-fee] ${PARTNER_SHAPE} [--units tokens|raw] [--yes] | submit --keypair <relayer file> --file <file> [--yes]`,
};

export function usageOf(verb: string | undefined): { usage: string; options: string[] } {
  const known = verb !== undefined && ACCEPTS[verb] !== undefined;
  return {
    usage: known ? `${verb} ${SHAPES[verb] ?? ""}`.trim() : COMMANDS,
    options: known ? [...(ACCEPTS[verb] ?? []), ...GLOBAL_OPTIONS].map((o) => `--${o}`) : [],
  };
}

export function parse(argv: readonly string[], env: Env = {}): Command {
  noRepeats(argv);
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const values: Values = { ...parsed.values };
  const [verb, sub, third, extra] = parsed.positionals;
  if (verb === "help" || values.help === true) {
    return { name: "help", verb: verb === "help" ? sub : verb };
  }
  if (verb === "version" || values.version === true) {
    const others = Object.entries(values).filter(([key, value]) => value !== undefined && key !== "version" && key !== "output");
    if (others.length > 0 || parsed.positionals.length > (verb === "version" ? 1 : 0)) {
      throw new UsageError("version takes no arguments but --output");
    }
    return { name: "version" };
  }
  outputOf(argv);
  const keypairDefault = env[ENV_KEYPAIR];
  if (
    !(verb === "signed" && sub === "submit") &&
    values.keypair === undefined &&
    values.authority === undefined &&
    keypairDefault !== undefined &&
    verb !== undefined &&
    ACCEPTS[verb]?.includes("keypair") === true
  ) {
    values.keypair = keypairDefault;
  }
  const nested = verb === "mandate" || verb === "signed";
  if (extra !== undefined || (!nested && third !== undefined)) {
    throw new UsageError(`unexpected argument ${nested ? extra : third}`);
  }
  onlyAccepted(verb, sub, values);
  unitsOf(values);
  const remote = {
    url: clusterUrl(values.url ?? env[ENV_URL] ?? (verb === "setup" ? SETUP_CLUSTER : DEFAULT_URL)),
    priority: parsePriority(values["priority-fee"]),
  };
  named(values, remote.url);
  switch (verb) {
    case "pda":
      noSub(sub);
      return { name: "pda", owner: key(values, "owner"), nonce: u64(values, "nonce") };
    case "hash":
      noSub(sub);
      return { name: "hash", artifact: required(values, "artifact") };
    case "show":
      if (sub === "config") {
        return { name: "show-config", ...remote };
      }
      if (sub === "intent") {
        return { name: "show-intent", ...remote, owner: key(values, "owner"), nonce: u64(values, "nonce") };
      }
      throw new UsageError("show needs config or intent");
    case "setup":
      noSub(sub);
      return { name: "setup", ...remote, keypair: values.keypair };
    case "balance":
      noSub(sub);
      if (values.owner !== undefined && parsed.values.keypair !== undefined) {
        throw new UsageError(BALANCE_OF_ONE);
      }
      return {
        name: "balance",
        ...remote,
        keypair: values.owner === undefined ? required(values, "keypair") : undefined,
        owner: values.owner === undefined ? undefined : key(values, "owner"),
        mints: values.mints === undefined ? null : mintList(values.mints),
      };
    case "domain":
      noSub(sub);
      return { name: "domain", ...remote };
    case "mcp":
      noSub(sub);
      if (values.wallet === true && remote.url === CLUSTERS["mainnet-beta"]) {
        throw new UsageError(WALLET_NOT_MAINNET);
      }
      return { name: "mcp", ...remote, relay: relaySpec(values), agent: agentSpec(values), wallet: walletLimits(values, remote.url) };
    case "quote":
      noSub(sub);
      return {
        name: "quote",
        ...remote,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        at: values.at === undefined ? undefined : parseI64(values.at, "at"),
      };
    case "cancel":
      noSub(sub);
      return {
        name: "cancel",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        nonce: u64(values, "nonce"),
        close: values.close === true,
      };
    case "expire":
    case "close":
      noSub(sub);
      return {
        name: verb,
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
      };
    case "advance-nonce":
      noSub(sub);
      return { name: "advance-nonce", ...remote, keypair: required(values, "keypair"), base: u64(values, "base") };
    case "advance-epoch":
      noSub(sub);
      return { name: "advance-epoch", ...remote, keypair: required(values, "keypair") };
    case "init-config":
      noSub(sub);
      return {
        name: "init-config",
        ...remote,
        by: authorityOf(values),
        guardian: key(values, "guardian"),
        feeRecipient: key(values, "fee-recipient"),
        feeBps: parseFeeBps(required(values, "fee-bps")),
        enabledKinds: parseKinds(required(values, "kinds")),
        paused: parsePause(values.flags ?? "none", "flags"),
      };
    case "raise-pause":
    case "lower-pause": {
      noSub(sub);
      const flags = parsePause(required(values, "flags"), "flags");
      if (flags === 0) {
        throw new UsageError("--flags must name at least one of create, fill or all");
      }
      return { name: verb, ...remote, by: authorityOf(values), flags };
    }
    case "set-economics": {
      noSub(sub);
      const kindFees = parseKindFees(values["kind-fees"] ?? "");
      return {
        name: "set-economics",
        ...remote,
        by: authorityOf(values),
        economics: {
          kindFeeMask: kindFees.mask,
          kindFeeBps: kindFees.bps,
          partnerCutBps: parseBounded(values["partner-cut"] ?? "0", "partner-cut", 0xffff),
          crankBounty: parseBounded(required(values, "bounty"), "bounty", 0xffff_ffff),
          createFee: parseBounded(required(values, "create-fee"), "create-fee", 0xffff_ffff),
        },
      };
    }
    case "solve": {
      noSub(sub);
      const tipLamports = values.tip === undefined ? 0n : u64(values, "tip");
      if (tipLamports > 0n && values.jito === undefined) {
        throw new UsageError("--tip pays a jito tip and needs --jito");
      }
      if (values.interval !== undefined && values.watch !== true) {
        throw new UsageError("--interval needs --watch");
      }
      if (remote.priority !== "auto" && remote.priority > AUTO_PRICE_CAP) {
        throw new UsageError(solveFeeAboveCap);
      }
      return {
        name: "solve",
        ...remote,
        keypair: required(values, "keypair"),
        ...market(values),
        jito: values.jito === undefined ? undefined : https(values.jito, "jito"),
        tipLamports,
        minProfit: profitFloors(required(values, "min-profit")),
        maxFeeBps: parseBounded(values["max-fee-bps"] ?? "100", "max-fee-bps", 200),
        maxSolCost: values["max-sol-cost"] === undefined ? DEFAULT_MAX_SOL_COST : parseSolCost(values["max-sol-cost"]),
        maxRent: values["max-rent"] === undefined ? DEFAULT_MAX_RENT : parseMaxRent(values["max-rent"]),
        slippageBps: parseBounded(values["slippage-bps"] ?? "50", "slippage-bps", 10_000),
        routeProgram: values["route-program"] === undefined ? undefined : parseAddress(values["route-program"], "route-program"),
        lookupTables: values["lookup-table"] === undefined ? [] : addressList(values["lookup-table"], "lookup-table"),
        watch: values.watch === true ? parseBounded(values.interval ?? String(WATCH_INTERVAL), "interval", MAX_FOLLOW_INTERVAL, 1) : null,
      };
    }
    case "update-config":
      noSub(sub);
      return { name: "update-config", ...remote, by: authorityOf(values), change: configChange(values) };
    case "propose-admin":
      noSub(sub);
      return { name: "propose-admin", ...remote, by: authorityOf(values), pendingAdmin: key(values, "new-admin") };
    case "accept-admin":
      noSub(sub);
      return { name: "accept-admin", ...remote, by: authorityOf(values) };
    case "events":
      noSub(sub);
      if (values.follow === true) {
        return {
          name: "follow",
          ...remote,
          limit: values.limit === undefined ? 20 : parseLimit(values.limit),
          interval: parseBounded(values.interval ?? "10", "interval", MAX_FOLLOW_INTERVAL, 1),
        };
      }
      if (values.interval !== undefined) {
        throw new UsageError("--interval needs --follow");
      }
      return { name: "events", ...remote, limit: values.limit === undefined ? 20 : parseLimit(values.limit) };
    case "treasury":
      noSub(sub);
      return treasury(remote, values);
    case "jobs":
      noSub(sub);
      return { name: "jobs", ...remote, attestor: values.attestor === undefined ? undefined : key(values, "attestor") };
    case "deliver":
      noSub(sub);
      return {
        name: "deliver",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        intent: key(values, "intent"),
        sha256: sha256Of(required(values, "sha256")),
        workUrl: memoUrlOf(required(values, "work-url"), "work-url"),
      };
    case "deliveries":
      noSub(sub);
      return { name: "deliveries", ...remote, attestor: key(values, "attestor"), intent: key(values, "intent"), maxPages: maxPagesOf(values) };
    case "receipt":
      noSub(sub);
      return {
        name: "receipt",
        ...remote,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        sha256: values.sha256 === undefined ? undefined : sha256Of(values.sha256),
      };
    case "judge":
      noSub(sub);
      return {
        name: "judge",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        spec: required(values, "spec"),
        artifact: required(values, "artifact"),
        run: runOf(required(values, "run")),
        payTo: values["pay-to"] === undefined ? undefined : key(values, "pay-to"),
        result: values.result === undefined ? undefined : u64(values, "result"),
        timeout: parseBounded(values.timeout ?? String(JUDGE_TIMEOUT), "timeout", MAX_JUDGE_TIMEOUT, 1),
        verdict: values.verdict,
        maxPages: maxPagesOf(values),
      };
    case "solver-table":
      noSub(sub);
      return { name: "solver-table", ...remote, solver: key(values, "solver"), mints: mintList(required(values, "mints")) };
    case "crank":
      noSub(sub);
      return {
        name: "crank",
        ...remote,
        keypair: required(values, "keypair"),
        dryRun: values["dry-run"] === true,
        fundAccounts: values["fund-accounts"] === true,
      };
    case "create":
      return {
        name: "flow",
        ...remote,
        flow: "create",
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        input: createTerms(sub, values),
      };
    case "list":
      noSub(sub);
      if (values.owner === undefined && values.keypair === undefined) {
        throw new UsageError("list needs --owner or --keypair");
      }
      return {
        name: "lookup",
        ...remote,
        lookup: "list",
        keypair: values.keypair,
        input: optionalField(values, "owner", "owner", key),
      };
    case "mandate":
      return mandate(sub, third, remote, values);
    case "approve":
    case "revoke-approval":
      noSub(sub);
      return {
        name: "flow",
        ...remote,
        flow: verb,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        input: { mint: key(values, "mint"), ...(verb === "approve" ? { amount: amountOf(values, "amount") } : {}) },
      };
    case "signed": {
      if (sub === "submit") {
        noSub(third);
        return {
          name: "signed-submit",
          ...remote,
          keypair: required(values, "keypair"),
          yes: values.yes === true,
          file: required(values, "file"),
        };
      }
      if (sub !== "prepare") {
        throw new UsageError("signed needs prepare or submit");
      }
      return {
        name: "signed-prepare",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        out: required(values, "out"),
        input: {
          ...terms(third, values),
          ...optionalField(values, "submit-within", "submit_within", (v, n) =>
            parseBounded(required(v, n), n, MAX_SUBMIT_WITHIN),
          ),
          ...optionalField(values, "relayer-fee", "relayer_fee", amountOf),
        },
      };
    }
    default:
      throw new UsageError(USAGE);
  }
}
