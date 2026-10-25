import { SdkError } from "@intent-engine/core";

export const UNEXPECTED_REDIRECT = "unexpected redirect";

export type FetchFailure = "redirect" | "status" | "network" | "no-address" | "aborted";

export class FetchFailed extends SdkError {
  readonly code = "fetch-failed";
  override readonly name = "FetchFailed";
  readonly url: string;
  readonly reason: FetchFailure;
  readonly detail: string;

  constructor(url: string, reason: FetchFailure, detail: string, options?: ErrorOptions) {
    super("fetch failed", options);
    this.url = url;
    this.reason = reason;
    this.detail = detail;
  }
}

export type CheckedFetch = (url: string, init: { redirect: "error"; signal: AbortSignal; addresses: readonly string[] }) => Promise<Response>;
