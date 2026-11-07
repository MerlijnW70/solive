import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { isSdkError } from "@intent-engine/client";
import { DEVNET_URL } from "./tokens.js";

export type RpcCause = { kind: "http"; status: number } | { kind: "json-rpc" } | { kind: "unreached" } | { kind: "dropped" };

const UNREACHED: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const DROPPED: ReadonlySet<unknown> = new Set(["ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

const CAUSE_DEPTH = 8;
const JSON_RPC_FIRST = -32_000;
const JSON_RPC_LAST = -32_768;

export function rpcCause(error: unknown): RpcCause | null {
  if (isSdkError(error)) {
    return null;
  }
  let link: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && link instanceof Error; depth++, link = link.cause) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return { kind: "http", status: link.context.statusCode };
    }
    if (isSolanaError(link) && link.context.__code <= JSON_RPC_FIRST && link.context.__code >= JSON_RPC_LAST) {
      return { kind: "json-rpc" };
    }
    const code = (link as { code?: unknown }).code;
    if (UNREACHED.has(code)) {
      return { kind: "unreached" };
    }
    if (DROPPED.has(code)) {
      return { kind: "dropped" };
    }
  }
  return null;
}

export const RATE_LIMITED_HINT = "the public devnet node rate-limited this request; retry in a minute, or pass another --url";

export const NODE_RATE_LIMITED = "the RPC node rate-limited this request; retry in a minute, or pass another --url";

export const rateLimitedHint = (url: string | undefined): string => (url === DEVNET_URL ? RATE_LIMITED_HINT : NODE_RATE_LIMITED);

export const rpcFailed = (error: unknown): boolean => rpcCause(error) !== null;

export const HTTP_RATE_LIMITED = 429;

export const HTTP_SERVER_ERROR = 500;

export const HTTP_LASTING: ReadonlySet<number> = new Set([501, 505]);

const temporaryHttp = (status: number): boolean => status === HTTP_RATE_LIMITED || (status >= HTTP_SERVER_ERROR && !HTTP_LASTING.has(status));

export function rpcTemporary(error: unknown): boolean {
  if (isSdkError(error, "timed-out") || isSdkError(error, "rate-limited")) {
    return true;
  }
  const cause = rpcCause(error);
  return cause !== null && (cause.kind === "unreached" || cause.kind === "dropped" || (cause.kind === "http" && temporaryHttp(cause.status)));
}
