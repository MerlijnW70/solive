import type { Address } from "@solana/kit";
import type { Values } from "./arg-options.js";
import { https, parseAddress, parseBounded, parseU64, UsageError } from "./arg-values.js";
import type { Command, Remote } from "./command-types.js";
import { tokenNamed } from "./tokens.js";

export const EXIT_ALERTED = 4;
export const MONITOR_INTERVAL = 30;
export const MIN_MONITOR_INTERVAL = 5;
export const MAX_MONITOR_INTERVAL = 3_600;
export const MAX_MONITOR_FILLS = 999;

export const MONITOR_NEEDS_BASELINE =
  "monitor needs --expect <baseline file>; write one first with monitor --write-baseline <file> after checking the current config and program are the ones you intend";

export const BASELINE_ALONE = "--write-baseline writes the current values and exits, so it takes no other monitor option but --url";

export const MAX_FILL_FORMAT = "--max-fill takes <mint>=<raw amount>, once per input mint";

function maxFills(entries: readonly string[], url: string): ReadonlyMap<Address, bigint> {
  const limits = new Map<Address, bigint>();
  for (const entry of entries) {
    const at = entry.lastIndexOf("=");
    if (at <= 0) {
      throw new UsageError(MAX_FILL_FORMAT);
    }
    const named = tokenNamed(entry.slice(0, at).trim(), url);
    if (named instanceof Error) {
      throw new UsageError(named.message);
    }
    const mint = parseAddress(named, "max-fill");
    if (limits.has(mint)) {
      throw new UsageError(`${MAX_FILL_FORMAT}; ${mint} is given twice`);
    }
    limits.set(mint, parseU64(entry.slice(at + 1).trim(), "max-fill"));
  }
  return limits;
}

export function monitorOf(remote: Remote, values: Values): Command {
  const watching = [values.expect, values.interval, values["max-fill"], values["max-fills"], values.webhook, values.once];
  const write = values["write-baseline"];
  if (write !== undefined) {
    if (watching.some((v) => v !== undefined)) {
      throw new UsageError(BASELINE_ALONE);
    }
    return { name: "monitor", ...remote, baseline: write, watch: null };
  }
  if (values.expect === undefined) {
    throw new UsageError(MONITOR_NEEDS_BASELINE);
  }
  if (values.webhook !== undefined) {
    https(values.webhook, "webhook");
  }
  return {
    name: "monitor",
    ...remote,
    baseline: values.expect,
    watch: {
      interval: parseBounded(values.interval ?? String(MONITOR_INTERVAL), "interval", MAX_MONITOR_INTERVAL, MIN_MONITOR_INTERVAL),
      maxFill: maxFills(values["max-fill"] ?? [], remote.url),
      maxFills: values["max-fills"] === undefined ? null : parseBounded(values["max-fills"], "max-fills", MAX_MONITOR_FILLS),
      webhook: values.webhook ?? null,
      once: values.once === true,
    },
  };
}
