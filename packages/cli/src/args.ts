import { parseArgs } from "node:util";
import { ADD_TO_APPS } from "./add-to.js";
import { AUTO_PRICE_CAP } from "./compute.js";
import { MAX_SUBMIT_WITHIN } from "./agent/signed.js";
import { CLUSTERS, clusterUrl, DEFAULT_URL, ENV_KEYPAIR, ENV_URL, WALLET_NOT_MAINNET } from "./clusters.js";
import type { Values } from "./arg-options.js";
import {
  addressList,
  amountOf,
  confirmUrlOf,
  https,
  key,
  mintList,
  named,
  noRepeats,
  noSub,
  acceptedBy,
  onlyAccepted,
  optionalField,
  outputOf,
  parseAddress,
  parseBounded,
  parseFeeBps,
  parseI64,
  parseKindFees,
  parseKinds,
  parseLimit,
  parseMaxRent,
  parsePause,
  parsePriority,
  parseSolCost,
  required,
  u64,
  unitsOf,
  UsageError,
} from "./arg-values.js";
import {
  agentSpec,
  ALL_TOOLS_NEED_WALLET,
  authorityOf,
  configChange,
  market,
  maxPagesOf,
  profitTargets,
  relaySpec,
  solValues,
  solveFeeAboveCap,
  treasury,
  walletLimits,
} from "./command-builders.js";
import { createTerms, mandate, terms } from "./order-builders.js";
import { USAGE } from "./arg-usage.js";
import { optionsFor, trustOf } from "./trust-args.js";
import { monitorOf } from "./monitor-args.js";
import { jobArgsOf } from "./job-args.js";
import type { Command, Env } from "./command-types.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST, MAX_BUNDLE, MAX_CONCURRENCY } from "@intent-engine/solver";
import { MIN_CAP_WINDOW_SECS } from "@intent-engine/core";

export type { Authority, Command, Env, WalletLimits } from "./command-types.js";
export { ACCEPTS, GLOBAL_OPTIONS, type Side, SUB_ACCEPTS, TOKEN_SIDES, type Tokens } from "./arg-options.js";
export { COMMANDS, SHAPES, USAGE, usageOf } from "./arg-usage.js";
export {
  MAX_EVENT_LIMIT,
  MAX_RENT_FORMAT,
  MAX_SOL_COST_FORMAT,
  outputOf,
  parseFeeBps,
  parseI64,
  parseKinds,
  parseLimit,
  parseMaxRent,
  parsePause,
  parsePriority,
  parseSolCost,
  parseU64,
  SHA256_NEEDED,
  UsageError,
} from "./arg-values.js";
export { expiry, MANDATE_USE_KINDS, needsSpecHash, order, SPEC_HASH_FORMAT } from "./order-builders.js";
export {
  AGENT_DEFAULT_HOURLY_LAMPORTS,
  AGENT_NEEDS_OWNERS,
  ALL_TOOLS_NEED_WALLET,
  ISSUE_ALONE,
  ISSUE_FORMAT,
  INVENTORY_ALONE,
  INVENTORY_FORMAT,
  JUDGE_TIMEOUT,
  MAX_DELIVERY_PAGES,
  MAX_JUDGE_TIMEOUT,
  ONE_MARKET,
  RELAY_DEFAULT_HOURLY_LAMPORTS,
  RELAY_DEFAULT_TTL,
  RELAY_MAX_TTL,
  RELAY_NEEDS_FEES,
  RELEASE_NEEDED,
  RUN_NEEDED,
  solveFeeAboveCap,
  TREASURY_CREATE_NEEDS_MINTS,
  WALLET_LIMITS_NEED_WALLET,
  zeroProfit,
} from "./command-builders.js";

export { CLUSTERS, clusterUrl, DEFAULT_URL, ENV_KEYPAIR, ENV_URL, WALLET_NOT_MAINNET } from "./clusters.js";

const SETUP_CLUSTER = "devnet";

export const BUNDLE_SIZE_NEEDS_JITO = "--bundle-size sets how many fills share one jito bundle and needs --jito";

export const ADD_TO_NEEDS_APP = "add-to needs the app to add the server to: add-to claude or add-to codex";

const WALLET_LIMIT_KEYS = ["wallet-per-trade", "wallet-per-hour"] as const;

const BALANCE_OF_ONE ="balance takes --keypair or --owner, not both";

export const MAX_FOLLOW_INTERVAL = 3_600;
export const WATCH_INTERVAL = 5;
export const QUOTE_TTL = 10;

export function parse(argv: readonly string[], env: Env = {}): Command {
  noRepeats(argv);
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: optionsFor(argv), allowPositionals: true, strict: true });
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
    acceptedBy(verb, sub)?.includes("keypair") === true
  ) {
    values.keypair = keypairDefault;
  }
  const nested = verb === "mandate" || verb === "signed";
  if (extra !== undefined || (!nested && third !== undefined)) {
    throw new UsageError(`unexpected argument ${nested ? extra : third}`);
  }
  onlyAccepted(verb, sub, values);
  unitsOf(values);
  if (verb === "add-to") {
    const app = ADD_TO_APPS.find((a) => a === sub);
    if (app === undefined) {
      throw new UsageError(ADD_TO_NEEDS_APP);
    }
    walletLimits({ ...values, wallet: true }, clusterUrl("devnet"));
    const limits = WALLET_LIMIT_KEYS.flatMap((k) => {
      const text = values[k];
      return text === undefined ? [] : [`--${k}`, text.replace(/\s+/g, "")];
    });
    return { name: "add-to", app, limits };
  }
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
    case "seal":
      noSub(sub);
      return { name: "seal", file: required(values, "file"), to: addressList(required(values, "to"), "to"), out: required(values, "out") };
    case "unseal":
      noSub(sub);
      return { name: "unseal", file: required(values, "file"), keypair: required(values, "keypair"), out: required(values, "out") };
    case "spec":
      noSub(sub);
      return { name: "spec", ...remote, intent: key(values, "intent"), keypair: values.keypair, out: values.out };
    case "show":
      if (sub === "config") {
        return { name: "show-config", ...remote };
      }
      if (sub === "intent") {
        return { name: "show-intent", ...remote, owner: key(values, "owner"), nonce: u64(values, "nonce") };
      }
      if (sub === "mint-cap") {
        return { name: "show-mint-cap", ...remote, mint: key(values, "mint") };
      }
      throw new UsageError("show needs config, intent or mint-cap");
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
      if (values["all-tools"] === true && values.wallet !== true) {
        throw new UsageError(ALL_TOOLS_NEED_WALLET);
      }
      return {
        name: "mcp",
        ...remote,
        relay: relaySpec(values),
        agent: agentSpec(values),
        wallet: walletLimits(values, remote.url),
        allTools: values["all-tools"] === true,
        ...confirmUrlOf(values),
      };
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
      if (values["bundle-size"] !== undefined && values.jito === undefined) {
        throw new UsageError(BUNDLE_SIZE_NEEDS_JITO);
      }
      if (values.interval !== undefined && values.watch !== true) {
        throw new UsageError("--interval needs --watch");
      }
      if (values["quote-ttl"] !== undefined && values.watch !== true) {
        throw new UsageError("--quote-ttl needs --watch");
      }
      if (values.stats === true && values.watch !== true) {
        throw new UsageError("--stats needs --watch");
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
        ...(values.jito === undefined ? {} : { bundleSize: parseBounded(values["bundle-size"] ?? String(MAX_BUNDLE), "bundle-size", MAX_BUNDLE, 1) }),
        ...profitTargets(values),
        ...(values["sol-value"] === undefined ? {} : { solValue: solValues(values["sol-value"]) }),
        maxFeeBps: parseBounded(values["max-fee-bps"] ?? "100", "max-fee-bps", 200),
        maxSolCost: values["max-sol-cost"] === undefined ? DEFAULT_MAX_SOL_COST : parseSolCost(values["max-sol-cost"]),
        maxRent: values["max-rent"] === undefined ? DEFAULT_MAX_RENT : parseMaxRent(values["max-rent"]),
        slippageBps: parseBounded(values["slippage-bps"] ?? "50", "slippage-bps", 10_000),
        routeProgram: values["route-program"] === undefined ? undefined : parseAddress(values["route-program"], "route-program"),
        lookupTables: values["lookup-table"] === undefined ? [] : addressList(values["lookup-table"], "lookup-table"),
        concurrency: parseBounded(values.concurrency ?? String(DEFAULT_CONCURRENCY), "concurrency", MAX_CONCURRENCY, 1),
        watch: values.watch === true ? parseBounded(values.interval ?? String(WATCH_INTERVAL), "interval", MAX_FOLLOW_INTERVAL, 1) : null,
        ...(values.watch === true ? { quoteTtl: parseBounded(values["quote-ttl"] ?? String(QUOTE_TTL), "quote-ttl", MAX_FOLLOW_INTERVAL) } : {}),
        ...(values.watch === true && values.stats === true ? { stats: true } : {}),
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
    case "set-mint-cap": {
      noSub(sub);
      const maxPerOrder = u64(values, "max-per-order");
      const windowCap = u64(values, "window-cap");
      if (maxPerOrder === 0n) {
        throw new UsageError("--max-per-order must be above zero");
      }
      if (windowCap < maxPerOrder) {
        throw new UsageError("--window-cap must be at least --max-per-order");
      }
      return {
        name: "set-mint-cap",
        ...remote,
        by: authorityOf(values),
        mint: key(values, "mint"),
        maxPerOrder,
        windowCap,
        windowSecs: parseBounded(required(values, "window-secs"), "window-secs", 0xffff_ffff, MIN_CAP_WINDOW_SECS),
      };
    }
    case "set-caps-required":
      if (sub !== "on" && sub !== "off") {
        throw new UsageError("set-caps-required needs on or off");
      }
      return { name: "set-caps-required", ...remote, by: authorityOf(values), required: sub === "on" };
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
    case "receipt":
    case "record-delivery":
    case "judge":
      return jobArgsOf(verb, sub, remote, values);
    case "deliveries":
      noSub(sub);
      return { name: "deliveries", ...remote, attestor: key(values, "attestor"), intent: key(values, "intent"), maxPages: maxPagesOf(values) };
    case "solver-table":
      noSub(sub);
      return { name: "solver-table", ...remote, solver: key(values, "solver"), mints: mintList(required(values, "mints")) };
    case "monitor":
      noSub(sub);
      return monitorOf(remote, values);
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
    case "committee":
    case "reputation":
    case "feedback":
    case "claims":
    case "profile":
      return trustOf(verb, sub, remote, values);
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
