import { TOKEN_AMOUNT_PATTERN } from "@intent-engine/core/internal";
import type { Values } from "./arg-options.js";
import { confirmUrlOf, encryptionKeypairOf, feePayerOf, key, memoUrlOf, noSub, parseBounded, relayPayerOf, required, saltOf, sha256Of, solLamports, u64, UsageError } from "./arg-values.js";
import { JUDGE_TIMEOUT, MAX_JUDGE_TIMEOUT, releaseOption, runOf } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";
import { MAX_FOLLOW_INTERVAL } from "./arg-solve.js";
import { sandboxOf } from "./sandbox.js";
import { ANNOUNCE_WAIT, MAX_ANNOUNCE_WAIT } from "./announce-wait.js";

export const JUDGE_WATCH_INTERVAL = 30;

export const RUN_OPTIONS = ["sandbox", "sandbox-image", "sandbox-memory", "sandbox-cpus", "sandbox-tmp", "sandbox-gpu", "plain-node", "i-trust-this-work", "timeout"] as const;
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
  return parseBounded(values.interval ?? String(JUDGE_WATCH_INTERVAL), "interval", MAX_FOLLOW_INTERVAL, 1);
}

export const WATCH_TAKES_NO_WAIT = "judge --watch judges only announcements it already sees, so it takes no --announce-wait";

function announceWaitOf(values: Values, watch: number | null): number {
  if (watch !== null) {
    if (values["announce-wait"] !== undefined) {
      throw new UsageError(WATCH_TAKES_NO_WAIT);
    }
    return 0;
  }
  return parseBounded(values["announce-wait"] ?? String(ANNOUNCE_WAIT), "announce-wait", MAX_ANNOUNCE_WAIT, 0);
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
        given: RUN_OPTIONS.filter((option) => values[option] !== undefined),
        ...feePayerOf(values, keypair),
        ...encryptionKeypairOf(values),
        ...confirmUrlOf(values, remote.url),
        ...(values.review === undefined ? {} : { reviews: values.review }),
        announceWait: announceWaitOf(values, watch),
      };
    }
  }
}

export const JOB_NEEDS_CREATE = "job needs create: job create --name <job> --spec <file> --worker-key <name> --amount <SOL>";
export const NAME_RULE = "must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit";
export const JOB_AMOUNT_FORMAT = "--amount must be a SOL amount like 0.05";
export const JOB_FUND = 20_000_000n;
export const JOB_EXPIRES_IN = 604_800;
const MAX_JOB_EXPIRES_IN = 315_360_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function nameOf(values: Values, key: "name" | "worker-key"): string {
  const text = required(values, key);
  if (!NAME.test(text)) {
    throw new UsageError(`--${key} ${NAME_RULE}`);
  }
  return text;
}

export function jobCreateOf(sub: string | undefined, remote: Remote, values: Values): Command {
  if (sub !== "create") {
    throw new UsageError(JOB_NEEDS_CREATE);
  }
  const amount = required(values, "amount");
  if (!TOKEN_AMOUNT_PATTERN.test(amount) || !/[1-9]/.test(amount)) {
    throw new UsageError(JOB_AMOUNT_FORMAT);
  }
  return {
    name: "job-create",
    ...remote,
    keypair: required(values, "keypair"),
    yes: values.yes === true,
    job: nameOf(values, "name"),
    spec: required(values, "spec"),
    workerKey: nameOf(values, "worker-key"),
    amount,
    fund: values.fund === undefined ? JOB_FUND : solLamports(values, "fund"),
    expiresIn: String(parseBounded(values["expires-in"] ?? String(JOB_EXPIRES_IN), "expires-in", MAX_JOB_EXPIRES_IN, 1)),
    ...(values["backup-dir"] === undefined ? {} : { backupDir: values["backup-dir"] }),
    ...(values["keys-dir"] === undefined ? {} : { keysDir: values["keys-dir"] }),
    ...(values["jobs-dir"] === undefined ? {} : { jobsDir: values["jobs-dir"] }),
    noPublishSpec: values["no-publish-spec"] === true,
  };
}
