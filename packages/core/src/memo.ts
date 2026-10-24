import { type Address, isAddress } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";
import { InvalidInput } from "./errors.js";

export const SPEC_MEMO_PREFIX = `${PRODUCT_SLUG}-spec:`;
export const RELEASE_MEMO_PREFIX = "delivery sha256:";
export const FEEDBACK_MEMO_PREFIX = `${PRODUCT_SLUG}-feedback:`;
export const MAX_FEEDBACK_SCORE = 100;
export const MAX_MEMO_URL = 200;

export const RELEASE_SALT_MARK = " salt:";

export type SpecMemo = { url: string };

export type ReleaseRecord = { sha256: string; salt?: string };

const RELEASE_SALT = /^[0-9a-f]{32}$/;

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
    throw new InvalidInput("url", "format", `a spec url must be ${MEMO_URL_RULE}`);
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

export function releaseMemo(sha256: string, salt?: string): string {
  if (!isSha256Hex(sha256)) {
    throw new InvalidInput("sha256", "format", "a release records a sha256 of 64 lowercase hex digits");
  }
  if (salt !== undefined && !RELEASE_SALT.test(salt)) {
    throw new InvalidInput("salt", "format", "a release records its payee's salt as 32 lowercase hex digits");
  }
  return `${RELEASE_MEMO_PREFIX}${sha256}${salt === undefined ? "" : `${RELEASE_SALT_MARK}${salt}`}`;
}

export function parseRelease(text: string): ReleaseRecord | null {
  if (!text.startsWith(RELEASE_MEMO_PREFIX)) {
    return null;
  }
  const [sha256 = "", salt, ...rest] = text.slice(RELEASE_MEMO_PREFIX.length).split(RELEASE_SALT_MARK);
  if (rest.length > 0 || !isSha256Hex(sha256) || (salt !== undefined && !RELEASE_SALT.test(salt))) {
    return null;
  }
  return salt === undefined ? { sha256 } : { sha256, salt };
}

export function parseReleaseMemo(text: string): string | null {
  return parseRelease(text)?.sha256 ?? null;
}

const SCORE = /^(0|[1-9][0-9]{0,2})$/;

export function feedbackMemo({ intent, score, note }: FeedbackMemo): string {
  if (!isAddress(intent)) {
    throw new InvalidInput("intent", "format", "feedback names its intent by a base58 address");
  }
  if (!Number.isInteger(score) || score < 0 || score > MAX_FEEDBACK_SCORE) {
    throw new InvalidInput("score", "range", `a feedback score is a whole number from 0 to ${MAX_FEEDBACK_SCORE}`);
  }
  if (note !== undefined && !isSha256Hex(note)) {
    throw new InvalidInput("note", "format", "a feedback note is the sha256 of the note as 64 lowercase hex digits");
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
