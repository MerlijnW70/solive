import { isSdkError, type Lookup } from "@intent-engine/client";
import { publicAddresses } from "@intent-engine/client/internal";
import { lastingSpecRead, SPEC_NOT_PUBLIC } from "./fetch-class.js";
import { InviteRefused } from "./invites.js";
import { JudgeRefused, JudgeUnreadable } from "./judge-errors.js";

export const fetchFailure = (error: unknown): string => {
  if (isSdkError(error, "fetch-failed")) {
    return `${error.message}: ${error.detail}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return cause === "" ? message : `${message}: ${cause}`;
};

export const lastingFailure = (error: unknown): boolean =>
  isSdkError(error, "fetch-failed") ? error.reason === "redirect" || error.reason === "status" : /redirect/.test(fetchFailure(error));

export type Reached = { addresses: string[] } | "private" | "unresolved";

export async function reached(hostname: string, lookup: Lookup, loopback: boolean): Promise<Reached> {
  let answered = true;
  const watched: Lookup = async (host) => {
    try {
      const found = await lookup(host);
      answered = found.length > 0;
      return found;
    } catch (error) {
      answered = false;
      throw error;
    }
  };
  const addresses = await publicAddresses(hostname, watched, loopback);
  return addresses !== null ? { addresses } : answered ? "private" : "unresolved";
}

const SPEC_AT = "the spec at ";

export async function lastingSpecFailure(message: string, lookup: Lookup): Promise<boolean> {
  if (lastingSpecRead({ message }, false)) {
    return true;
  }
  const tail = ` ${SPEC_NOT_PUBLIC}`;
  if (!message.startsWith(SPEC_AT) || !message.endsWith(tail)) {
    return false;
  }
  let host: string;
  try {
    host = new URL(message.slice(SPEC_AT.length, -tail.length)).hostname;
  } catch {
    return false;
  }
  return (await reached(host, lookup, false)) === "private";
}

export async function inviteRefusal(error: unknown, lookup: Lookup): Promise<unknown> {
  if (!(error instanceof InviteRefused)) {
    return error;
  }
  if (error.code !== "SpecUnreadable" || (await lastingSpecFailure(error.detail ?? "", lookup))) {
    return new JudgeRefused(error.message);
  }
  return new JudgeUnreadable(error.message);
}
