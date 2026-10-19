import { AUTO_PRICE_CAP } from "./compute.js";
import type { Values } from "./arg-options.js";
import { addressList, confirmUrlOf, https, parseAddress, parseBounded, parseMaxRent, parseSolCost, required, u64, UsageError } from "./arg-values.js";
import { market, profitTargets, solValues, solveFeeAboveCap } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_RENT, DEFAULT_MAX_SOL_COST, MAX_BUNDLE, MAX_CONCURRENCY } from "@intent-engine/solver";

export const BUNDLE_SIZE_NEEDS_JITO = "--bundle-size sets how many fills share one jito bundle and needs --jito";

export const MAX_FOLLOW_INTERVAL = 3_600;
export const WATCH_INTERVAL = 5;
export const QUOTE_TTL = 10;

export function solveOf(remote: Remote, values: Values): Command {
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
    ...confirmUrlOf(values),
  };
}
