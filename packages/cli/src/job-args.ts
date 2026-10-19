import { TOKEN_AMOUNT_PATTERN } from "@intent-engine/core";
import type { Values } from "./arg-options.js";
import { confirmUrlOf, key, memoUrlOf, noSub, parseBounded, required, sha256Of, u64, UsageError } from "./arg-values.js";
import { JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, maxPagesOf, releaseOption, runOf } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";
import { sandboxOf } from "./sandbox.js";

export const JUDGE_WATCH_INTERVAL = 30;
export const MAX_JUDGE_INTERVAL = 3_600;
export const WATCH_TAKES_NO_ARTIFACT = "judge --watch fetches each delivery from its url and takes no --artifact";

function watchOf(values: Values): number | null {
  if (values.watch !== true) {
    if (values.interval !== undefined) {
      throw new UsageError("--interval needs --watch");
    }
    return null;
  }
  if (values.artifact !== undefined) {
    throw new UsageError(WATCH_TAKES_NO_ARTIFACT);
  }
  return parseBounded(values.interval ?? String(JUDGE_WATCH_INTERVAL), "interval", MAX_JUDGE_INTERVAL, 1);
}

export const DELIVER_ONE_OF = "deliver takes exactly one of --artifact <file or directory> and --sha256 <64 hex>";

function workOf(values: Values): { sha256: string } | { artifact: string } {
  if ((values.artifact === undefined) === (values.sha256 === undefined)) {
    throw new UsageError(DELIVER_ONE_OF);
  }
  return values.artifact === undefined ? { sha256: sha256Of(required(values, "sha256")) } : { artifact: values.artifact };
}

export const MIN_PAY_FORMAT = "--min-pay must be a token amount like 12 or 0.5";

function minPayOf(values: Values): string | undefined {
  const text = values["min-pay"];
  if (text !== undefined && !TOKEN_AMOUNT_PATTERN.test(text)) {
    throw new UsageError(MIN_PAY_FORMAT);
  }
  return text;
}

export function jobArgsOf(verb: "jobs" | "deliver" | "receipt" | "record-delivery" | "judge", sub: string | undefined, remote: Remote, values: Values): Command {
  noSub(sub);
  switch (verb) {
    case "jobs":
      return {
        name: "jobs",
        ...remote,
        attestor: values.attestor === undefined ? undefined : key(values, "attestor"),
        mint: values.mint === undefined ? undefined : key(values, "mint"),
        minPay: minPayOf(values),
      };
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
      const watch = watchOf(values);
      return {
        name: "judge",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        spec: required(values, "spec"),
        artifact: watch === null ? required(values, "artifact") : "",
        watch,
        run: sandbox.kind === "viper" ? undefined : runOf(required(values, "run")),
        payTo: values["pay-to"] === undefined ? undefined : key(values, "pay-to"),
        result: values.result === undefined ? undefined : u64(values, "result"),
        timeout: parseBounded(values.timeout ?? String(JUDGE_TIMEOUT), "timeout", MAX_JUDGE_TIMEOUT, 1),
        verdict: values.verdict,
        maxPages: maxPagesOf(values),
        check: values.check,
        sandbox,
        ...confirmUrlOf(values),
      };
    }
  }
}
