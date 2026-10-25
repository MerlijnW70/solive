import type { Values } from "./arg-options.js";
import { key, noSub, parseBounded, parseFeeBps, parseKindFees, parseKinds, parsePause, required, u64, UsageError } from "./arg-values.js";
import { authorityOf, configChange } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";
import { MIN_CAP_WINDOW_SECS } from "@intent-engine/core/internal";

export type AdminVerb =
  | "init-config"
  | "raise-pause"
  | "lower-pause"
  | "set-economics"
  | "update-config"
  | "propose-admin"
  | "accept-admin"
  | "set-mint-cap"
  | "set-caps-required"
  | "set-committee-floor";

export function adminOf(verb: AdminVerb, sub: string | undefined, remote: Remote, values: Values): Command {
  switch (verb) {
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
        ...(values["total-limit"] === undefined ? {} : { totalLimit: u64(values, "total-limit") }),
      };
    }
    case "set-caps-required":
      if (sub !== "on" && sub !== "off") {
        throw new UsageError("set-caps-required needs on or off");
      }
      return { name: "set-caps-required", ...remote, by: authorityOf(values), required: sub === "on" };
    case "set-committee-floor":
      noSub(sub);
      return { name: "set-committee-floor", ...remote, by: authorityOf(values), mint: key(values, "mint"), floor: u64(values, "floor") };
  }
}
