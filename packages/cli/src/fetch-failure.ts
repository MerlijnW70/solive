import { isSdkError, type Lookup } from "@intent-engine/client";
import { MAX_SPEC_BYTES, PLAIN_HTTP_ON_PUBLIC, publicAddresses, SPEC_REDIRECTS } from "@intent-engine/client/internal";
import { InviteRefused } from "./invites.js";
import { JudgeRefused, JudgeUnreadable } from "./judge-errors.js";

const TEMPORARY_STATUS: ReadonlySet<number> = new Set([408, 425, 429]);

export const temporaryStatus = (status: number): boolean => status >= 500 || TEMPORARY_STATUS.has(status);

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

export const SPEC_NOT_HTTP = "is not an http or https url";

export const SPEC_NOT_PUBLIC = "points to a private, loopback or local network address, which is not fetched";

const SPEC_AT = "the spec at ";

const LASTING_SPEC: readonly string[] = ["is not a url", SPEC_NOT_HTTP, PLAIN_HTTP_ON_PUBLIC, SPEC_REDIRECTS, `is larger than ${MAX_SPEC_BYTES} bytes`];

export async function lastingSpecFailure(message: string, lookup: Lookup): Promise<boolean> {
  const status = / answered (\d{3})$/.exec(message);
  if (status !== null) {
    return !temporaryStatus(Number(status[1]));
  }
  if (LASTING_SPEC.some((reason) => message.endsWith(` ${reason}`))) {
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
