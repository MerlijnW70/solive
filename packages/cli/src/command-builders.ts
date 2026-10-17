import { AUTO_PRICE_CAP } from "./compute.js";
import { tokenNamed } from "./tokens.js";
import type { Values } from "./arg-options.js";
import {
  https,
  key,
  mintAmounts,
  mintList,
  parseAddress,
  parseBounded,
  parseFeeBps,
  parseKinds,
  parseKindSet,
  parseU64,
  required,
  u64,
  UsageError,
} from "./arg-values.js";
import type { AgentSpec, Authority, Command, ConfigChange, IssueSpec, RelaySpec, Remote, WalletLimits } from "./command-types.js";
import type { Address } from "@solana/kit";
import { TOKEN_AMOUNT_PATTERN } from "@intent-engine/core";
import { DELIVERY_PAGES } from "@intent-engine/client";

export const RELAY_NEEDS_FEES =
  "--relayer needs --relay-fee naming every input token it relays as mint=amount; amount may be 0, and other tokens are refused";

export const AGENT_NEEDS_OWNERS = "--agent needs --agent-owners naming every owner whose mandates this agent key may use";

export const RELAY_DEFAULT_TTL = 24 * 60 * 60;
export const RELAY_DEFAULT_HOURLY_LAMPORTS = 100_000_000n;
export const AGENT_DEFAULT_HOURLY_LAMPORTS = 50_000_000n;
export const RELAY_MAX_TTL = 365 * 24 * 60 * 60;
const RELAY_DEFAULT_PER_HOUR = 10;
const RELAY_MIN_TTL = 60;

export function relaySpec(values: Values): RelaySpec | undefined {
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

export const WALLET_LIMITS_NEED_WALLET = "--wallet-per-trade and --wallet-per-hour need --wallet";

export const ALL_TOOLS_NEED_WALLET = "--all-tools needs --wallet; without it the server already serves every tool";

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

export function walletLimits(values: Values, url: string): WalletLimits | null {
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

export function agentSpec(values: Values): AgentSpec | undefined {
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

export const solveFeeAboveCap = `solve takes a --priority-fee of at most ${AUTO_PRICE_CAP} micro-lamports per compute unit, the cap of auto`;

export const zeroProfit = (mint: string): string => `--min-profit for ${mint} must be above 0, or every fill of it can lose SOL`;

export function profitFloors(text: string): ReadonlyMap<Address, bigint> {
  const floors = mintAmounts(text, "min-profit");
  for (const [mint, floor] of floors) {
    if (floor === 0n) {
      throw new UsageError(zeroProfit(mint));
    }
  }
  return floors;
}

export function authorityOf(values: Values): Authority {
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

export function configChange(values: Values): ConfigChange {
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

export function market(values: Values): { jupiter: string | undefined; issue: IssueSpec[] } {
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

export const TREASURY_CREATE_NEEDS_MINTS =
  "--create needs --mints naming the tokens to open treasury accounts for; anyone can open intents in any token, so the list must be yours";

export function treasury(remote: Remote, values: Values): Command {
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

export const RELEASE_NEEDED = "--release needs the release's base58 transaction signature";

const RELEASE_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export function releaseOption(values: Values): { release?: string } {
  if (values.release === undefined) {
    return {};
  }
  if (!RELEASE_SIGNATURE.test(values.release)) {
    throw new UsageError(RELEASE_NEEDED);
  }
  return { release: values.release };
}

export const MAX_DELIVERY_PAGES = 100_000;

export function maxPagesOf(values: Values): number {
  return parseBounded(values["max-pages"] ?? String(DELIVERY_PAGES), "max-pages", MAX_DELIVERY_PAGES, 1);
}

export const JUDGE_TIMEOUT = 600;
export const MAX_JUDGE_TIMEOUT = 86_400;
export const RUN_NEEDED = "--run must name the command that checks the artifact";

export function runOf(text: string): string {
  if (text.trim() === "") {
    throw new UsageError(RUN_NEEDED);
  }
  return text;
}
