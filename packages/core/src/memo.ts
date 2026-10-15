import { type Address, isAddress } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";

export const SPEC_MEMO_PREFIX = `${PRODUCT_SLUG}-spec:`;
export const DELIVERY_MEMO_PREFIX = `${PRODUCT_SLUG}-delivery:`;
export const RELEASE_MEMO_PREFIX = "delivery sha256:";
export const FEEDBACK_MEMO_PREFIX = `${PRODUCT_SLUG}-feedback:`;
export const MAX_FEEDBACK_SCORE = 100;
export const MAX_MEMO_URL = 200;
export const MAX_DELIVERY_MEMO = DELIVERY_MEMO_PREFIX.length + 44 + 1 + 64 + 1 + MAX_MEMO_URL;

export type SpecMemo = { url: string };

export type DeliveryMemo = { intent: Address; sha256: string; url: string };

export type FeedbackMemo = { intent: Address; score: number; note?: string };

export const MEMO_URL_RULE = `an https url of at most ${MAX_MEMO_URL} printable characters without spaces or backslashes, or http on localhost, 127.0.0.1 or [::1], in canonical form: lowercase scheme and host, no default port, no . or .. path segments, a / path before any ? or #, and characters percent-encoded as new URL() would`;

const PRINTABLE = /^[!-~]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isMemoUrl(url: string): boolean {
  if (!isLegacyMemoUrl(url)) {
    return false;
  }
  const parsed = new URL(url);
  const bareOrigin = parsed.href === `${url}/` && parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  return parsed.href === url || bareOrigin;
}

export function isLegacyMemoUrl(url: string): boolean {
  if (url.length > MAX_MEMO_URL || !PRINTABLE.test(url) || url.includes("\\")) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") {
    return false;
  }
  if (url.startsWith("https://")) {
    return parsed.protocol === "https:";
  }
  return url.startsWith("http://") && parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname);
}

export function isSha256Hex(text: string): boolean {
  return SHA256.test(text);
}

export function specMemo(url: string): string {
  if (!isMemoUrl(url)) {
    throw new RangeError(`a spec url must be ${MEMO_URL_RULE}`);
  }
  return `${SPEC_MEMO_PREFIX}${url}`;
}

export function parseSpecMemo(text: string): SpecMemo | null {
  if (text.length > SPEC_MEMO_PREFIX.length + MAX_MEMO_URL || !text.startsWith(SPEC_MEMO_PREFIX)) {
    return null;
  }
  const url = text.slice(SPEC_MEMO_PREFIX.length);
  return isLegacyMemoUrl(url) ? { url } : null;
}

export function deliveryMemo({ intent, sha256, url }: DeliveryMemo): string {
  if (!isAddress(intent)) {
    throw new RangeError("a delivery names its intent by a base58 address");
  }
  if (!isSha256Hex(sha256)) {
    throw new RangeError("a delivery's sha256 must be 64 lowercase hex digits");
  }
  if (!isMemoUrl(url)) {
    throw new RangeError(`a delivery url must be ${MEMO_URL_RULE}`);
  }
  return `${DELIVERY_MEMO_PREFIX}${intent}:${sha256}:${url}`;
}

export function parseDeliveryMemo(text: string): DeliveryMemo | null {
  if (text.length > MAX_DELIVERY_MEMO || !text.startsWith(DELIVERY_MEMO_PREFIX)) {
    return null;
  }
  const rest = text.slice(DELIVERY_MEMO_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 0) {
    return null;
  }
  const intent = rest.slice(0, split);
  const sha256 = rest.slice(split + 1, split + 65);
  const url = rest.slice(split + 66);
  if (rest[split + 65] !== ":" || !isAddress(intent) || !isSha256Hex(sha256) || !isLegacyMemoUrl(url)) {
    return null;
  }
  return { intent, sha256, url };
}

export function releaseMemo(sha256: string): string {
  if (!isSha256Hex(sha256)) {
    throw new RangeError("a release records a sha256 of 64 lowercase hex digits");
  }
  return `${RELEASE_MEMO_PREFIX}${sha256}`;
}

export function parseReleaseMemo(text: string): string | null {
  const sha256 = text.slice(RELEASE_MEMO_PREFIX.length);
  return text.startsWith(RELEASE_MEMO_PREFIX) && isSha256Hex(sha256) ? sha256 : null;
}

const SCORE = /^(0|[1-9][0-9]{0,2})$/;

export function feedbackMemo({ intent, score, note }: FeedbackMemo): string {
  if (!isAddress(intent)) {
    throw new RangeError("feedback names its intent by a base58 address");
  }
  if (!Number.isInteger(score) || score < 0 || score > MAX_FEEDBACK_SCORE) {
    throw new RangeError(`a feedback score is a whole number from 0 to ${MAX_FEEDBACK_SCORE}`);
  }
  if (note !== undefined && !isSha256Hex(note)) {
    throw new RangeError("a feedback note is the sha256 of the note as 64 lowercase hex digits");
  }
  return `${FEEDBACK_MEMO_PREFIX}${intent}:${score}${note === undefined ? "" : `:${note}`}`;
}

export function parseFeedbackMemo(text: string): FeedbackMemo | null {
  if (!text.startsWith(FEEDBACK_MEMO_PREFIX)) {
    return null;
  }
  const [intent = "", score = "", note, ...rest] = text.slice(FEEDBACK_MEMO_PREFIX.length).split(":");
  if (rest.length > 0 || !isAddress(intent) || !SCORE.test(score) || Number(score) > MAX_FEEDBACK_SCORE) {
    return null;
  }
  if (note !== undefined && !isSha256Hex(note)) {
    return null;
  }
  return { intent, score: Number(score), ...(note === undefined ? {} : { note }) };
}
