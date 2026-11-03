import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import { isSdkError } from "@intent-engine/core";
import { RATE_LIMITED, RateLimited } from "./jupiter.js";

export const NODE_RATE_LIMITED = "the node is rate limiting this solver; try again on the next run";

const CAUSE_DEPTH = 8;

const STATUS_IN_TEXT = new RegExp(`\\b${RATE_LIMITED}\\b`);

function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let link = error; link instanceof Error && chain.length < CAUSE_DEPTH; link = link.cause) {
    chain.push(link);
  }
  return chain;
}

export function nodeRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isSdkError(error)) {
    return (error as { code?: unknown }).code === "rate-limited";
  }
  const chain = causes(error);
  for (const link of chain) {
    if (isSolanaError(link, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return link.context.statusCode === RATE_LIMITED;
    }
  }
  return chain.some((link) => !isSolanaError(link) && STATUS_IN_TEXT.test(link.message));
}

export function haltOf(error: unknown): string | null {
  if (error instanceof RateLimited) {
    return error.message;
  }
  if (!nodeRateLimited(error)) {
    return null;
  }
  return error instanceof Error && isSdkError(error) ? error.message : NODE_RATE_LIMITED;
}
