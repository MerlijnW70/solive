import type { Values } from "./arg-options.js";
import { encryptionKeypairOf, key, memoUrlOf, relayPayerOf, required, splitOf } from "./arg-values.js";
import type { Command, Remote } from "./command-types.js";

export function announceArgsOf(verb: "deliveries" | "refute" | "reclaim" | "close-book", remote: Remote, values: Values): Command {
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
    case "close-book":
      return { name: "close-book", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, intent: key(values, "intent") };
  }
}
