import { PLAIN_HTTP_ON_PUBLIC, SPEC_REDIRECTS } from "@intent-engine/client/internal";

export type SpecFailure = { message: string; status?: number | null; url?: string };

export const SPEC_NOT_PUBLIC = "points to a private, loopback or local network address, which is not fetched";

const TEMPORARY_STATUS: ReadonlySet<number> = new Set([408, 425, 429]);

export const HTTP_SERVER_ERROR = 500;

export const HTTP_LASTING: ReadonlySet<number> = new Set([501, 505]);

export const temporaryServerError = (status: number): boolean => status >= HTTP_SERVER_ERROR && !HTTP_LASTING.has(status);

export const temporaryStatus = (status: number): boolean => temporaryServerError(status) || TEMPORARY_STATUS.has(status);

const LASTING_REASONS: readonly string[] = ["is not a url", "is not an http or https url", PLAIN_HTTP_ON_PUBLIC, SPEC_REDIRECTS, SPEC_NOT_PUBLIC];

const ANSWERED = /(?:^| )answered (\d{3})$/;

const TOO_LARGE = /(?:^| )is larger than \d+ bytes$/;

const SEALED_UNOPENED = "is sealed but could not be opened";

function reasonOf({ message, url }: SpecFailure): string | undefined {
  const lead = url === undefined ? undefined : `the spec at ${url} `;
  return lead !== undefined && message.startsWith(lead) ? message.slice(lead.length) : undefined;
}

export const statusOf = (failure: SpecFailure): number | undefined => {
  if (failure.status !== undefined && failure.status !== null) {
    return failure.status;
  }
  const found = ANSWERED.exec(reasonOf(failure) ?? failure.message);
  return found === null ? undefined : Number(found[1]);
};

export function lastingSpecRead(failure: SpecFailure, privateAddress: boolean): boolean {
  const status = statusOf(failure);
  if (status !== undefined) {
    return !temporaryStatus(status);
  }
  const reason = reasonOf(failure);
  const said = (text: string): boolean => (reason === undefined ? failure.message.endsWith(` ${text}`) : reason === text);
  if (reason !== undefined && (reason === SEALED_UNOPENED || reason.startsWith(`${SEALED_UNOPENED}: `))) {
    return true;
  }
  const larger = TOO_LARGE.test(reason ?? failure.message);
  return larger || LASTING_REASONS.some((text) => (privateAddress || text !== SPEC_NOT_PUBLIC) && said(text));
}
