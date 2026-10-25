import { TOKEN_AMOUNT_PATTERN } from "@intent-engine/core/internal";
import type { Values } from "./arg-options.js";
import { confirmUrlOf, encryptionKeypairOf, feePayerOf, key, memoUrlOf, noSub, parseBounded, relayPayerOf, required, saltOf, sha256Of, u64, UsageError } from "./arg-values.js";
import { JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, releaseOption, runOf } from "./command-builders.js";
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

export function jobArgsOf(verb: "jobs" | "deliver" | "receipt" | "judge", sub: string | undefined, remote: Remote, values: Values): Command {
  if (verb === "judge" && sub === "digest") {
    return {
      name: "judge-digest",
      ...remote,
      owner: key(values, "owner"),
      nonce: u64(values, "nonce"),
      announcement: key(values, "announcement"),
      sha256: sha256Of(required(values, "sha256")),
      salt: saltOf(required(values, "salt")),
      result: values.result === undefined ? undefined : u64(values, "result"),
    };
  }
  noSub(sub);
  switch (verb) {
    case "jobs":
      return {
        name: "jobs",
        ...remote,
        attestor: values.attestor === undefined ? undefined : key(values, "attestor"),
        mint: values.mint === undefined ? undefined : key(values, "mint"),
        minPay: minPayOf(values),
        unclaimed: values.unclaimed === true,
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
        ...relayPayerOf(values),
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
    case "judge": {
      const sandbox = sandboxOf(values);
      const watch = watchOf(values);
      const keypair = required(values, "keypair");
      return {
        name: "judge",
        ...remote,
        keypair,
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        spec: required(values, "spec"),
        artifact: watch === null ? required(values, "artifact") : "",
        watch,
        run: sandbox.kind === "viper" ? undefined : runOf(required(values, "run")),
        result: values.result === undefined ? undefined : u64(values, "result"),
        timeout: parseBounded(values.timeout ?? String(JUDGE_TIMEOUT), "timeout", MAX_JUDGE_TIMEOUT, 1),
        verdict: values.verdict,
        check: values.check,
        sandbox,
        ...feePayerOf(values, keypair),
        ...encryptionKeypairOf(values),
        ...confirmUrlOf(values, remote.url),
      };
    }
  }
}
