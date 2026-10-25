import type { Values } from "./arg-options.js";
import { encryptionKeypairOf, key, memoUrlOf, parseAddress, parseBounded, relayPayerOf, required, splitOf, UsageError } from "./arg-values.js";
import type { Command, Remote } from "./command-types.js";

export const HELD_NEEDS_ANNOUNCEMENT = "--index and --to choose which held share to claim and where, so they need --announcement";

const MAX_SPLIT_INDEX = 7;

function claimHeldOf(remote: Remote, values: Values): Command {
  const announcement = values.announcement === undefined ? undefined : parseAddress(values.announcement, "announcement");
  if (announcement === undefined && (values.index !== undefined || values.to !== undefined || values.yes === true)) {
    throw new UsageError(HELD_NEEDS_ANNOUNCEMENT);
  }
  return {
    name: "claim-held",
    ...remote,
    keypair: required(values, "keypair"),
    yes: values.yes === true,
    ...(announcement === undefined ? {} : { announcement }),
    ...(values.index === undefined ? {} : { index: parseBounded(values.index, "index", MAX_SPLIT_INDEX) }),
    ...(values.to === undefined ? {} : { to: parseAddress(values.to, "to") }),
    ...relayPayerOf(values),
  };
}

export function announceArgsOf(verb: "deliveries" | "refute" | "reclaim" | "claim-held" | "close-book", remote: Remote, values: Values): Command {
  switch (verb) {
    case "deliveries":
      return { name: "deliveries", ...remote, intent: key(values, "intent"), judgeKeypair: values["judge-keypair"], ...encryptionKeypairOf(values) };
    case "refute":
      return {
        name: "refute",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        earlier: key(values, "earlier"),
        paid: key(values, "paid"),
        ...(values["work-url"] === undefined ? {} : { workUrl: memoUrlOf(values["work-url"], "work-url") }),
        ...splitOf(values),
        ...relayPayerOf(values),
      };
    case "reclaim":
      return { name: "reclaim", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, ...relayPayerOf(values) };
    case "claim-held":
      return claimHeldOf(remote, values);
    case "close-book":
      return { name: "close-book", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, intent: key(values, "intent") };
  }
}
