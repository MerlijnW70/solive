import type { Values } from "./arg-options.js";
import { key, memoUrlOf, noSub, parseBounded, required, sha256Of, u64, UsageError } from "./arg-values.js";
import { JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, maxPagesOf, releaseOption, runOf } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";
import { sandboxOf } from "./sandbox.js";

export const DELIVER_ONE_OF = "deliver takes exactly one of --artifact <file or directory> and --sha256 <64 hex>";

function workOf(values: Values): { sha256: string } | { artifact: string } {
  if ((values.artifact === undefined) === (values.sha256 === undefined)) {
    throw new UsageError(DELIVER_ONE_OF);
  }
  return values.artifact === undefined ? { sha256: sha256Of(required(values, "sha256")) } : { artifact: values.artifact };
}

export function jobArgsOf(verb: "deliver" | "receipt" | "record-delivery" | "judge", sub: string | undefined, remote: Remote, values: Values): Command {
  noSub(sub);
  switch (verb) {
    case "deliver":
      return {
        name: "deliver",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        intent: key(values, "intent"),
        ...workOf(values),
        workUrl: memoUrlOf(required(values, "work-url"), "work-url"),
      };
    case "receipt":
      return {
        name: "receipt",
        ...remote,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        sha256: values.sha256 === undefined ? undefined : sha256Of(values.sha256),
        ...releaseOption(values),
      };
    case "record-delivery":
      return {
        name: "record-delivery",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        sha256: sha256Of(required(values, "sha256")),
        ...releaseOption(values),
      };
    case "judge": {
      const sandbox = sandboxOf(values);
      return {
        name: "judge",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        spec: required(values, "spec"),
        artifact: required(values, "artifact"),
        run: sandbox.kind === "viper" ? undefined : runOf(required(values, "run")),
        payTo: values["pay-to"] === undefined ? undefined : key(values, "pay-to"),
        result: values.result === undefined ? undefined : u64(values, "result"),
        timeout: parseBounded(values.timeout ?? String(JUDGE_TIMEOUT), "timeout", MAX_JUDGE_TIMEOUT, 1),
        verdict: values.verdict,
        maxPages: maxPagesOf(values),
        check: values.check,
        sandbox,
      };
    }
  }
}
