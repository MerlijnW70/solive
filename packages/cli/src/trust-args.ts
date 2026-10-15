import { parseArgs } from "node:util";
import type { Address } from "@solana/kit";
import {
  checkProfile,
  IntentCoreError,
  MAX_CLAIM_SECS,
  MAX_CLAIM_STAKE,
  MAX_COMMITTEE_MEMBERS,
  MAX_FEEDBACK_SCORE,
  parseAmount,
  TOKEN_AMOUNT_PATTERN,
} from "@intent-engine/core";
import { OPTIONS, PROFILE_OPTIONS, type Values } from "./arg-options.js";
import { addressList, key, noSub, parseAddress, parseBounded, required, sha256Of, u64, UsageError } from "./arg-values.js";
import { maxPagesOf } from "./command-builders.js";
import type { Command, Remote } from "./command-types.js";

export const COMMITTEE_SUBS = "committee needs create, show, vote or release";

function votesOf(values: Values): string[] {
  const votes = values.vote ?? [];
  if (votes.length === 0) {
    throw new UsageError("committee release needs at least one --vote <file>");
  }
  return votes;
}

function membersOf(values: Values): Address[] {
  const members = addressList(required(values, "members"), "members");
  if (members.length > MAX_COMMITTEE_MEMBERS) {
    throw new UsageError(`--members takes at most ${MAX_COMMITTEE_MEMBERS} addresses`);
  }
  return members;
}

export function committeeOf(sub: string | undefined, remote: Remote, values: Values): Command {
  switch (sub) {
    case "create": {
      const members = membersOf(values);
      return {
        name: "committee-create",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        members,
        threshold: parseBounded(required(values, "threshold"), "threshold", members.length, 1),
        feeWallet: key(values, "fee-wallet"),
      };
    }
    case "show":
      return { name: "committee-show", ...remote, committee: key(values, "committee") };
    case "vote":
      return {
        name: "committee-vote",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce: u64(values, "nonce"),
        payTo: key(values, "pay-to"),
        result: u64(values, "result"),
        out: values.out,
      };
    case "release":
      return {
        name: "committee-release",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        votes: votesOf(values),
        sha256: values.sha256 === undefined ? undefined : sha256Of(values.sha256),
      };
    default:
      throw new UsageError(COMMITTEE_SUBS);
  }
}

export function reputationOf(sub: string | undefined, remote: Remote, values: Values): Command {
  noSub(sub);
  return { name: "reputation", ...remote, worker: key(values, "worker"), maxPages: maxPagesOf(values) };
}

export function feedbackOf(sub: string | undefined, remote: Remote, values: Values): Command {
  noSub(sub);
  return {
    name: "feedback",
    ...remote,
    keypair: required(values, "keypair"),
    yes: values.yes === true,
    intent: key(values, "intent"),
    score: parseBounded(required(values, "score"), "score", MAX_FEEDBACK_SCORE),
    note: values.note === undefined ? undefined : sha256Of(values.note, "--note must be the note's sha256 as 64 hex digits"),
  };
}

export const CLAIMS_SUBS = "claims needs show, open, take, drop or settle";
export const PROFILE_SUBS = "profile needs show, set or close";
export const STAKE_FORMAT = `--stake is SOL from 0 to ${MAX_CLAIM_STAKE / 1_000_000_000n} with at most 9 decimals, such as 0.01`;
export const PROFILE_RULE =
  "a profile needs --skills of 1 to 8 distinct tags, each 1 to 16 of a-z, 0-9 and - not starting or ending with -, an --endpoint of https:// and at most 128 printable characters without spaces or \\, and --doc-url only together with --doc-sha256";

export function optionsFor(argv: readonly string[]): typeof OPTIONS {
  const [verb] = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: false }).positionals;
  return (verb === "profile" ? PROFILE_OPTIONS : OPTIONS) as typeof OPTIONS;
}

function stakeOf(values: Values): bigint {
  const text = required(values, "stake");
  let lamports: bigint;
  try {
    lamports = TOKEN_AMOUNT_PATTERN.test(text) ? parseAmount(text, 9) : -1n;
  } catch {
    lamports = -1n;
  }
  if (lamports < 0n || lamports > MAX_CLAIM_STAKE) {
    throw new UsageError(STAKE_FORMAT);
  }
  return lamports;
}

function claimsOf(sub: string | undefined, remote: Remote, values: Values): Command {
  const nonce = u64(values, "nonce");
  switch (sub) {
    case "show":
      return { name: "claims-show", ...remote, owner: key(values, "owner"), nonce };
    case "open":
      return {
        name: "claims-open",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        nonce,
        maxSecs: parseBounded(required(values, "max-secs"), "max-secs", MAX_CLAIM_SECS, 1),
        stake: stakeOf(values),
      };
    case "take":
      return {
        name: "claims-take",
        ...remote,
        keypair: required(values, "keypair"),
        yes: values.yes === true,
        owner: key(values, "owner"),
        nonce,
        secs: parseBounded(required(values, "secs"), "secs", MAX_CLAIM_SECS, 1),
      };
    default:
      return { name: sub === "drop" ? "claims-drop" : "claims-settle", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, owner: key(values, "owner"), nonce };
  }
}

function profileInput(values: Values) {
  const docUrl = values["doc-url"];
  const docSha256 = values["doc-sha256"];
  const input = {
    skills: required(values, "skills").split(",").map((s) => s.trim()),
    endpoint: required(values, "endpoint"),
    ...(docUrl === undefined ? {} : { docUrl }),
    ...(docSha256 === undefined ? {} : { docSha256 }),
  };
  try {
    return checkProfile(input);
  } catch (error) {
    throw error instanceof IntentCoreError ? new UsageError(PROFILE_RULE) : error;
  }
}

function profileOf(sub: string | undefined, remote: Remote, values: Values): Command {
  switch (sub) {
    case "show":
      if (typeof values.wallet !== "string") {
        throw new UsageError("missing --wallet");
      }
      return { name: "profile-show", ...remote, wallet: parseAddress(values.wallet, "wallet") };
    case "set":
      return { name: "profile-set", ...remote, keypair: required(values, "keypair"), yes: values.yes === true, profile: profileInput(values) };
    case "close":
      return { name: "profile-close", ...remote, keypair: required(values, "keypair"), yes: values.yes === true };
    default:
      throw new UsageError(PROFILE_SUBS);
  }
}

export function trustOf(verb: string, sub: string | undefined, remote: Remote, values: Values): Command {
  switch (verb) {
    case "committee":
      return committeeOf(sub, remote, values);
    case "reputation":
      return reputationOf(sub, remote, values);
    case "feedback":
      return feedbackOf(sub, remote, values);
    case "claims":
      if (sub === undefined || !["show", "open", "take", "drop", "settle"].includes(sub)) {
        throw new UsageError(CLAIMS_SUBS);
      }
      return claimsOf(sub, remote, values);
    default:
      return profileOf(sub, remote, values);
  }
}
