import type { Address } from "@solana/kit";
import { MAX_COMMITTEE_MEMBERS, MAX_FEEDBACK_SCORE } from "@intent-engine/core";
import type { Values } from "./arg-options.js";
import { addressList, key, noSub, parseBounded, required, sha256Of, u64, UsageError } from "./arg-values.js";
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
