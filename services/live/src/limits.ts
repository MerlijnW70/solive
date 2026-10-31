import { PRODUCT_SLUG } from "@intent-engine/core";

export const FEED_SIGNATURE_PAGE = 100;
export const FEED_UNREAD_TRIES = 10;
export const FEED_TRANSACTIONS_PER_REFRESH = 20;
export const FEED_ACCOUNTS_EVERY_SECS = 300;
export const FEED_CALL_TIMEOUT_MS = 2500;
export const FEED_REFRESH_BUDGET_MS = 8000;
export const FEED_MAX_AGE_SECS = 30;
export const SERVICE_WINDOW_SECS = 900;
export const FEED_EVENTS = 50;
export const PAID_WINDOW_SECS = 7 * 24 * 60 * 60;
export const TOP_WORKERS = 10;
export const KEPT_JOBS = 500;
export const KEPT_PAID = 2000;
export const RETRY_AFTER_DEFAULT_SECS = FEED_MAX_AGE_SECS;

export const CLUSTER = "devnet";
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const FAUCET_URL = "https://" + PRODUCT_SLUG + "-faucet.vercel.app/api/drip";
export const DRIP_LAMPORTS = 500_000_000n;
export const SOL_DECIMALS = 9;
export const STATE_KEY = "live-feed-state-v1";

export const CACHE_CONTROL = "public, max-age=10";
export const CDN_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400";

export type Limits = {
  readonly signaturePage: number;
  readonly transactionsPerRefresh: number;
  readonly accountsEverySecs: number;
  readonly callTimeoutMs: number;
  readonly refreshBudgetMs: number;
  readonly maxAgeSecs: number;
  readonly serviceWindowSecs: number;
};

export const LIMITS: Limits = {
  signaturePage: FEED_SIGNATURE_PAGE,
  transactionsPerRefresh: FEED_TRANSACTIONS_PER_REFRESH,
  accountsEverySecs: FEED_ACCOUNTS_EVERY_SECS,
  callTimeoutMs: FEED_CALL_TIMEOUT_MS,
  refreshBudgetMs: FEED_REFRESH_BUDGET_MS,
  maxAgeSecs: FEED_MAX_AGE_SECS,
  serviceWindowSecs: SERVICE_WINDOW_SECS,
};
