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

const NETWORK_PREFIXES = ["UND_ERR_", "ERR_SSL_", "CERT_"] as const;

const TLS_CODES: ReadonlySet<unknown> = new Set([
  "EPROTO",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_TLS_RENEGOTIATION_DISABLED",
]);

const FETCH_FAILURES: ReadonlySet<string> = new Set(["fetch failed", "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "Network request failed"]);

const JSON_FAILURE = /^(?:Unexpected end of JSON input$|JSON\.parse|JSON Parse error: |The string did not match the expected pattern\.$|Unexpected non-whitespace character after JSON|[\s\S]* is not valid JSON$|[\s\S]* in JSON at position \d+)/;

const networkCode = (code: unknown): boolean =>
  NETWORK_CODES.has(code) || TLS_CODES.has(code) || (typeof code === "string" && NETWORK_PREFIXES.some((prefix) => code.startsWith(prefix)));

const transportFault = (link: Error): boolean =>
  (link instanceof TypeError && FETCH_FAILURES.has(link.message)) || (link instanceof SyntaxError && JSON_FAILURE.test(link.message));

export function isReadFailure(error: unknown): error is Error {
  if (isSdkError(error)) {
    return true;
  }
  let link: unknown = error;
  for (let depth = 0; link instanceof Error && depth < CAUSE_DEPTH; depth++, link = link.cause) {
    if (isSolanaError(link) || networkCode((link as { code?: unknown }).code) || transportFault(link)) {
      return true;
    }
  }
  return false;
}
