import { isSealed } from "@intent-engine/core/internal";
import type { Lookup } from "./address-ranges.js";
import { sha256Hex } from "./encoding.js";
import { webFetch } from "./job-specs.js";
import { before, guardedSend, type SendAnswer } from "./spec-fetch.js";
import { MAX_SPEC_BYTES, type SpecFetch, SpecUnreadable } from "./spec-guard.js";
import { MIRROR_UNUSABLE, mirrorProblem, mirrorUnusable, specMirror, SPEC_READ_MS, trimmed } from "./spec-sources.js";
import type { Transport } from "./transport.js";

export type SpecPublished = { published: true; sha256: string; url: string } | { published: false; sha256: string; reason: string };

export type PublishSpecOptions = {
  transport: Transport;
  fetch?: SpecFetch;
  lookup?: Lookup | null;
  rpcUrl?: string;
  mirror?: string | null;
  budgetMs?: number;
};

export const MIRROR_OFF = "no mirror is set, since INTENT_ENGINE_SPEC_MIRROR is empty";
export const PUBLISH_SEALED = "the spec is sealed, and a sealed spec is never uploaded";
export const SPEC_PUBLISH_OVER = "the upload ran out of time";

const BACKOFF_SHARE = 20;
const RETRIED: ReadonlySet<number> = new Set([403, 429, 503]);

const ANSWERS: Readonly<Record<number, string>> = {
  400: "it refused these bytes",
  403: "it sees no open escrow with this spec hash",
  413: "it refused a spec this large",
  429: "it is limiting uploads from this network",
  507: "it holds as much as it may store in total",
  503: "it or its node is not available",
};

const askedSeconds = ({ retryAfter }: SendAnswer): number | null => {
  return retryAfter !== null && /^[1-9]\d*$/.test(retryAfter) ? Number(retryAfter) : null;
};

const refusal = (url: string, answer: SendAnswer): string => {
  const seconds = askedSeconds(answer);
  return `${url} answered ${answer.status}${ANSWERS[answer.status] === undefined ? "" : `: ${ANSWERS[answer.status]}`}${answer.status === 429 && seconds !== null ? `; retry after ${seconds} seconds` : ""}`;
};

const paused = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function publishSpec(bytes: Uint8Array, options: PublishSpecOptions): Promise<SpecPublished> {
  const sha256 = await sha256Hex(bytes);
  const refused = (reason: string): SpecPublished => ({ published: false, sha256, reason });
  const mirror = options.mirror === undefined ? specMirror() : options.mirror;
  if (mirror === null) {
    return refused(MIRROR_OFF);
  }
  if (isSealed(bytes)) {
    return refused(PUBLISH_SEALED);
  }
  if (bytes.length > MAX_SPEC_BYTES) {
    return refused(`the spec is larger than ${MAX_SPEC_BYTES} bytes`);
  }
  if (mirrorUnusable(mirror)) {
    return refused(MIRROR_UNUSABLE);
  }
  const url = `${trimmed(mirror)}/sha256/${sha256}`;
  const budget = options.budgetMs ?? SPEC_READ_MS;
  const deadline = AbortSignal.timeout(budget);
  const ends = performance.now() + budget;
  const request = { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes } as const;
  const attempts = async (): Promise<SpecPublished> => {
    const problem = await mirrorProblem(options.transport, mirror);
    if (problem !== null) {
      return refused(problem);
    }
    for (let backoff = budget / BACKOFF_SHARE; ; backoff *= 2) {
      const answer = await guardedSend(options.transport, options.fetch ?? webFetch, url, options.lookup ?? null, options.rpcUrl, request, deadline);
      if (answer.status === 200 || answer.status === 201) {
        return { published: true, sha256, url };
      }
      const wait = Math.max((askedSeconds(answer) ?? 0) * 1000, backoff);
      if (!RETRIED.has(answer.status) || wait >= ends - performance.now()) {
        return refused(refusal(url, answer));
      }
      await paused(wait);
    }
  };
  try {
    return await before(deadline, attempts());
  } catch (error) {
    if (deadline.aborted) {
      return refused(SPEC_PUBLISH_OVER);
    }
    return refused(error instanceof SpecUnreadable ? error.message : `the upload to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
