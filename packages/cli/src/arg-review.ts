import type { Values } from "./arg-options.js";
import { key, required, sha256Of, u64, UsageError } from "./arg-values.js";
import type { Command, Remote } from "./command-types.js";
import { REASON_RULE, reasonFits, REVIEW_VERDICTS, type ReviewVerdict } from "./review.js";

export const REVIEW_ADD_ALONE = "review --add co-signs the statement in that file, so it takes no --owner, --nonce, --artifact, --sha256, --outcome or --reason";

export const REVIEW_ONE_WORK = "review takes exactly one of --artifact <file or directory> and --sha256 <64 hex>";

export const OUTCOME_RULE = "--outcome must be pay or fail";

export const reasonRule = `--reason must be ${REASON_RULE}`;

const STATEMENT_OPTIONS = ["owner", "nonce", "artifact", "sha256", "outcome", "reason"] as const;

function outcomeOf(values: Values): ReviewVerdict {
  const outcome = required(values, "outcome");
  if (!(REVIEW_VERDICTS as readonly string[]).includes(outcome)) {
    throw new UsageError(OUTCOME_RULE);
  }
  return outcome as ReviewVerdict;
}

function reasonOf(values: Values): string {
  const reason = required(values, "reason");
  if (!reasonFits(reason)) {
    throw new UsageError(reasonRule);
  }
  return reason;
}

export function reviewArgsOf(remote: Remote, values: Values): Command {
  const base = { name: "review" as const, ...remote, keypair: required(values, "keypair"), yes: values.yes === true, out: required(values, "out") };
  if (values.add !== undefined) {
    if (STATEMENT_OPTIONS.some((option) => values[option] !== undefined)) {
      throw new UsageError(REVIEW_ADD_ALONE);
    }
    return { ...base, statement: { add: values.add } };
  }
  if ((values.artifact === undefined) === (values.sha256 === undefined)) {
    throw new UsageError(REVIEW_ONE_WORK);
  }
  return {
    ...base,
    statement: {
      owner: key(values, "owner"),
      nonce: u64(values, "nonce"),
      work: values.artifact === undefined ? { sha256: sha256Of(required(values, "sha256")) } : { artifact: values.artifact },
      outcome: outcomeOf(values),
      reason: reasonOf(values),
    },
  };
}
