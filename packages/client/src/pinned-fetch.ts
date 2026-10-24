import { type IncomingMessage, request as plainRequest } from "node:http";
import { request as tlsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isSdkError, SdkError } from "@intent-engine/core";
import type { SpecFetch } from "./job-specs.js";

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

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NO_BODY: ReadonlySet<number> = new Set([204, 205, 304]);

const DECODERS: Readonly<Record<string, () => Transform>> = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };

const pinned =
  (url: string, addresses: readonly string[]): LookupFunction =>
  (_host, options, done) => {
    const found = addresses.map((address) => ({ address, family: isIP(address) }));
    const first = found[0];
    if (first === undefined) {
      done(new FetchFailed(url, "no-address", "no checked address to connect to"), "");
      return;
    }
    if (options.all === true) {
      done(null, found);
      return;
    }
    done(null, first.address, first.family);
  };

function headersOf(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, one);
    }
  }
  return headers;
}

function decoded(response: IncomingMessage): Readable {
  const decoder = DECODERS[String(response.headers["content-encoding"] ?? "").trim().toLowerCase()];
  return decoder === undefined ? response : pipeline(response, decoder(), () => undefined);
}

export const pinnedFetch: SpecFetch = (url, init) => {
  const addresses = init.addresses;
  if (addresses === undefined) {
    return fetch(url, { redirect: init.redirect, signal: init.signal });
  }
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? tlsRequest : plainRequest;
    const request = send(target, { method: "GET", lookup: pinned(url, addresses), signal: init.signal, headers: { "accept-encoding": "gzip, deflate, br" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status) || status < 200 || status > 599) {
        response.destroy();
        reject(REDIRECTS.has(status) ? new FetchFailed(url, "redirect", UNEXPECTED_REDIRECT) : new FetchFailed(url, "status", `answered status ${status}`));
        return;
      }
      init.signal.addEventListener("abort", () => response.destroy(init.signal.reason instanceof Error ? init.signal.reason : new FetchFailed(url, "aborted", "aborted")), { once: true });
      if (NO_BODY.has(status)) {
        response.destroy();
        resolve(new Response(null, { status, headers: headersOf(response) }));
        return;
      }
      resolve(new Response(Readable.toWeb(decoded(response)) as ReadableStream<Uint8Array>, { status, headers: headersOf(response) }));
    });
    request.on("error", (error) => reject(isSdkError(error, "fetch-failed") ? error : new FetchFailed(url, "network", error.message, { cause: error })));
    request.end();
  });
};
