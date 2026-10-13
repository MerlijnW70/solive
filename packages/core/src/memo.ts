import { type Address, isAddress } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";

export const SPEC_MEMO_PREFIX = `${PRODUCT_SLUG}-spec:`;
export const DELIVERY_MEMO_PREFIX = `${PRODUCT_SLUG}-delivery:`;
export const MAX_MEMO_URL = 200;
export const MAX_DELIVERY_MEMO = DELIVERY_MEMO_PREFIX.length + 44 + 1 + 64 + 1 + MAX_MEMO_URL;

export type SpecMemo = { url: string };

export type DeliveryMemo = { intent: Address; sha256: string; url: string };

export const MEMO_URL_RULE = `an https url of at most ${MAX_MEMO_URL} printable characters without spaces, or http on localhost`;

const PRINTABLE = /^[!-~]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isMemoUrl(url: string): boolean {
  if (url.length > MAX_MEMO_URL || !PRINTABLE.test(url)) {
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
  return isMemoUrl(url) ? { url } : null;
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
  if (rest[split + 65] !== ":" || !isAddress(intent) || !isSha256Hex(sha256) || !isMemoUrl(url)) {
    return null;
  }
  return { intent, sha256, url };
}
