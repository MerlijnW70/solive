import { isSdkError } from "@intent-engine/core";
import { UNEXPECTED_REDIRECT } from "./fetch-failed.js";
import { joinedBytes } from "./encoding.js";
import { hostAddresses, type Lookup, loopbackUrl } from "./address-ranges.js";
import { MAX_SPEC_BYTES, NOT_HTTP, NOT_PUBLIC_SPEC, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic, SPEC_FETCH_FAILED, SPEC_REDIRECTS, SPEC_SEND_FAILED, SPEC_TIMEOUT_MS, type SpecFetch, type SpecRequest, SpecUnreadable } from "./spec-guard.js";
import type { Transport } from "./transport.js";

const loopbackAllowed = (transport: Transport, rpcUrl?: string): boolean => transport.offline === true || (rpcUrl !== undefined && loopbackUrl(rpcUrl));

async function discarded(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function before<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function bounded(response: Response, url: string, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) {
    await discarded(response);
    throw new SpecUnreadable(url, `answered ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SPEC_BYTES) {
    await discarded(response);
    throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await before(signal, reader.read()); next.done !== true; next = await before(signal, reader.read())) {
      size += next.value.length;
      if (size > MAX_SPEC_BYTES) {
        throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return joinedBytes(chunks);
}

function fetchProblem(error: unknown, failed: string): string {
  if (isSdkError(error, "fetch-failed")) {
    return error.reason === "redirect" ? SPEC_REDIRECTS : `${failed} (${error.message}: ${error.detail})`;
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  if (cause === UNEXPECTED_REDIRECT) {
    return SPEC_REDIRECTS;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${failed} (${cause === "" ? message : `${message}: ${cause}`})`;
}

type Reach = { transport: Transport; get: SpecFetch; lookup: Lookup | null; rpcUrl: string | undefined; request: SpecRequest; deadline: AbortSignal | undefined; failed: string };

async function guarded<T>({ transport, get, lookup, rpcUrl, request, deadline, failed }: Reach, url: string, answer: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SpecUnreadable(url, "is not a url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SpecUnreadable(url, NOT_HTTP);
  }
  if (await plainHttpOnPublic(transport, url)) {
    throw new SpecUnreadable(url, PLAIN_HTTP_ON_PUBLIC);
  }
  const signal = deadline === undefined ? AbortSignal.timeout(SPEC_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(SPEC_TIMEOUT_MS), deadline]);
  try {
    const addresses = await before(signal, hostAddresses(parsed.hostname, lookup, loopbackAllowed(transport, rpcUrl)));
    if (addresses === null) {
      throw new SpecUnreadable(url, NOT_PUBLIC_SPEC);
    }
    const { method, headers, body } = request;
    const sent = { ...(method === undefined ? {} : { method }), ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }) };
    return await answer(await before(signal, get(url, { ...sent, redirect: "error", signal, ...(addresses === undefined ? {} : { addresses }) })), signal);
  } catch (error) {
    throw error instanceof SpecUnreadable ? error : new SpecUnreadable(url, fetchProblem(error, failed), { cause: error });
  }
}

export function guardedRead(transport: Transport, get: SpecFetch, url: string, lookup: Lookup | null, rpcUrl?: string, request: SpecRequest = {}, deadline?: AbortSignal): Promise<Uint8Array> {
  return guarded({ transport, get, lookup, rpcUrl, request, deadline, failed: SPEC_FETCH_FAILED }, url, (response, signal) => bounded(response, url, signal));
}

export type SendAnswer = { status: number; retryAfter: string | null; minEscrowed: string | null; limit: string | null };

export function guardedSend(transport: Transport, get: SpecFetch, url: string, lookup: Lookup | null, rpcUrl: string | undefined, request: SpecRequest, deadline: AbortSignal): Promise<SendAnswer> {
  return guarded({ transport, get, lookup, rpcUrl, request, deadline, failed: SPEC_SEND_FAILED }, url, async (response) => {
    await discarded(response);
    const { headers } = response;
    return { status: response.status, retryAfter: headers.get("retry-after"), minEscrowed: headers.get("x-min-escrowed"), limit: headers.get("x-spec-limit") };
  });
}
