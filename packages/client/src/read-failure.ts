import { isSolanaError } from "@solana/kit";
import { isSdkError } from "@intent-engine/core";

const CAUSE_DEPTH = 8;

const NETWORK_CODES: ReadonlySet<unknown> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
]);

const networkCode = (code: unknown): boolean => NETWORK_CODES.has(code) || (typeof code === "string" && code.startsWith("UND_ERR_"));

export function isReadFailure(error: unknown): error is Error {
  if (isSdkError(error)) {
    return true;
  }
  let link: unknown = error;
  for (let depth = 0; link instanceof Error && depth < CAUSE_DEPTH; depth++, link = link.cause) {
    if (isSolanaError(link) || networkCode((link as { code?: unknown }).code)) {
      return true;
    }
  }
  return false;
}
