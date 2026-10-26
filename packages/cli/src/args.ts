import { parseArgs } from "node:util";
import { ADD_TO_APPS } from "./add-to.js";
import { MAX_SUBMIT_WITHIN } from "./agent/signed.js";
import { CLUSTERS, clusterUrl, DEFAULT_URL, ENV_KEYPAIR, ENV_URL, SAVED_CONFIRM_URL, WALLET_NOT_MAINNET } from "./clusters.js";
import { adminOf } from "./arg-admin.js";
import { MAX_FOLLOW_INTERVAL, solveOf, solverOf } from "./arg-solve.js";
import type { Values } from "./arg-options.js";
import {
  addressList,
  amountOf,
  confirmUrlOf,
  encryptionKeypairOf,
  mcpEncryptionKeypair,
  mcpFeePayer,
  key,
  mintList,
  named,
  noRepeats,
  noSub,
  acceptedBy,
  onlyAccepted,
  optionalField,
  outputOf,
  parseBounded,
  parseI64,
  parseLimit,
  parsePriority,
  required,
  solLamports,
  u64,
  UNSEAL_NEEDS_KEY,
  unitsOf,
  UsageError,
} from "./arg-values.js";
import {
  agentSpec,
  ALL_TOOLS_NEED_WALLET,
  relaySpec,
  signatureOf,
  treasury,
  walletLimits,
} from "./command-builders.js";
import { createTerms, mandate, terms } from "./order-builders.js";
import { USAGE } from "./arg-usage.js";
import { optionsFor, trustOf } from "./trust-args.js";
import { monitorOf } from "./monitor-args.js";
import { jobArgsOf } from "./job-args.js";
import { announceArgsOf } from "./arg-announce.js";
import type { Command, Env } from "./command-types.js";

export type { Authority, Command, Env, WalletLimits } from "./command-types.js";
export {
  BUNDLE_SIZE_NEEDS_JITO,
  FLOAT_SHOW_TAKES,
  FLOAT_TAKES,
  INVENTORY_OWNER_ALONE,
  MAX_FOLLOW_INTERVAL,
  QUOTE_TTL,
  SOLVER_NEEDS_FLOAT,
  WATCH_INTERVAL,
} from "./arg-solve.js";
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
export const FAUCET_DEVNET_ONLY = "--faucet asks the devnet faucet, so it works only with --url devnet";

export const ADD_TO_NEEDS_APP = "add-to needs the app to add the server to: add-to claude or add-to codex";

const WALLET_LIMIT_KEYS = ["wallet-per-trade", "wallet-per-hour"] as const;

const BALANCE_OF_ONE ="balance takes --keypair or --owner, not both";

export const MIGRATE_ONE_OR_ALL = "migrate takes --address <account> or --all, not both";
export const CONFIRM_URL_OR_NOT = "--no-confirm-url skips the second node, so it takes no --confirm-url";

export const takesSavedConfirm = (verb: string | undefined, sub: string | undefined): boolean =>
  verb === "judge" || verb === "mcp" || (verb === "committee" && sub === "release");

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
  if (values["no-confirm-url"] === true && values["confirm-url"] !== undefined) {
    throw new UsageError(CONFIRM_URL_OR_NOT);
  }
  const confirmDefault = env[SAVED_CONFIRM_URL];
  if (
    values["confirm-url"] === undefined &&
    values["no-confirm-url"] !== true &&
    confirmDefault !== undefined &&
    takesSavedConfirm(verb, sub) &&
    acceptedBy(verb, sub)?.includes("confirm-url") === true
  ) {
    values["confirm-url"] = confirmDefault;
  }
  const nested = verb === "mandate" || verb === "signed" || verb === "solver" || (verb === "profile" && sub === "encryption-key");
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
    return { name: "add-to", app, limits, allowHttpRegistry: values["allow-http-registry"] === true };
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
      return { name: "seal", ...remote, file: required(values, "file"), to: addressList(required(values, "to"), "to"), out: required(values, "out") };
    case "unseal":
      noSub(sub);
      if (values.keypair === undefined && values["encryption-keypair"] === undefined) {
        throw new UsageError(UNSEAL_NEEDS_KEY);
      }
      return { name: "unseal", file: required(values, "file"), keypair: values.keypair, out: required(values, "out"), ...encryptionKeypairOf(values) };
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
      if (values.faucet === true && remote.url !== clusterUrl(SETUP_CLUSTER)) {
        throw new UsageError(FAUCET_DEVNET_ONLY);
      }
      return { name: "setup", ...remote, keypair: values.keypair, ...confirmUrlOf(values, remote.url), faucet: values.faucet === true };
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
    case "new-wallet":
      noSub(sub);
      return { name: "new-wallet", out: required(values, "out") };
    case "send-sol":
      noSub(sub);
      return { name: "send-sol", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, to: key(values, "to"), lamports: solLamports(values, "amount") };
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
        ...mcpFeePayer(values),
        ...mcpEncryptionKeypair(values),
        ...confirmUrlOf(values, remote.url),
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
    case "close-legacy":
      noSub(sub);
      return { name: "close-legacy", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, address: key(values, "address") };
    case "migrate": {
      noSub(sub);
      const all = values.all === true;
      if (all === (values.address !== undefined)) {
        throw new UsageError(MIGRATE_ONE_OR_ALL);
      }
      return { name: "migrate", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, address: all ? null : key(values, "address") };
    }
    case "advance-nonce":
      noSub(sub);
      return { name: "advance-nonce", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, base: u64(values, "base") };
    case "advance-epoch":
      noSub(sub);
      return { name: "advance-epoch", ...remote, keypair: required(values, "keypair") };
    case "solve":
      noSub(sub);
      return solveOf(remote, values);
    case "init-config":
    case "raise-pause":
    case "lower-pause":
    case "set-economics":
    case "update-config":
    case "propose-admin":
    case "accept-admin":
    case "set-mint-cap":
    case "set-caps-required":
    case "set-committee-floor":
      return adminOf(verb, sub, remote, values);
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
    case "deliver":
    case "receipt":
    case "judge":
      return jobArgsOf(verb, sub, remote, values);
    case "deliveries":
    case "refute":
    case "reclaim":
    case "claim-held":
    case "close-book":
      noSub(sub);
      return announceArgsOf(verb, remote, values);
    case "solver-table":
      noSub(sub);
      return { name: "solver-table", ...remote, solver: key(values, "solver"), mints: mintList(required(values, "mints")) };
    case "solver":
      return solverOf(sub, third, remote, values, parsed.values.keypair !== undefined);
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
    case "lookup":
      noSub(sub);
      return {
        name: "signature-lookup",
        ...remote,
        signature: signatureOf(values),
        validUntil: values["valid-until"] === undefined ? undefined : u64(values, "valid-until"),
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
      return trustOf(verb, sub, remote, values, third);
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
