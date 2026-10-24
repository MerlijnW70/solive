import { type IncomingMessage, request as plainRequest } from "node:http";
import { request as tlsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { SpecFetch } from "./job-specs.js";

export const UNEXPECTED_REDIRECT = "unexpected redirect";

export type CheckedFetch = (url: string, init: { redirect: "error"; signal: AbortSignal; addresses: readonly string[] }) => Promise<Response>;

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NO_BODY: ReadonlySet<number> = new Set([204, 205, 304]);

const DECODERS: Readonly<Record<string, () => Transform>> = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };

const pinned =
  (addresses: readonly string[]): LookupFunction =>
  (_host, options, done) => {
    const found = addresses.map((address) => ({ address, family: isIP(address) }));
    const first = found[0];
    if (first === undefined) {
      done(new Error("no checked address to connect to"), "");
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
    const request = send(target, { method: "GET", lookup: pinned(addresses), signal: init.signal, headers: { "accept-encoding": "gzip, deflate, br" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (REDIRECTS.has(status) || status < 200 || status > 599) {
        response.destroy();
        reject(new TypeError("fetch failed", { cause: new Error(REDIRECTS.has(status) ? UNEXPECTED_REDIRECT : `answered status ${status}`) }));
        return;
      }
      init.signal.addEventListener("abort", () => response.destroy(init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted")), { once: true });
      if (NO_BODY.has(status)) {
        response.destroy();
        resolve(new Response(null, { status, headers: headersOf(response) }));
        return;
      }
      resolve(new Response(Readable.toWeb(decoded(response)) as ReadableStream<Uint8Array>, { status, headers: headersOf(response) }));
    });
    request.on("error", (error) => reject(new TypeError("fetch failed", { cause: error })));
    request.end();
  });
};
