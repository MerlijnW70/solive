export type FeedKind = "escrow" | "claim" | "delivery" | "release" | "refund" | "swap";

export type ServiceState = "up" | "down" | "unknown";

export type FeedEvent = {
  kind: FeedKind;
  at: string;
  slot: number;
  signature: string;
  intent: string;
  who: string;
  amount: string | null;
  token: string | null;
  house: boolean;
  spec_hash: string | null;
  spec_name: string | null;
  detail: string;
  payee?: string;
  attestor?: string;
};

export type Step = { signature: string; at: string; who: string; amount: string | null; token: string | null };

export type LatestPaidJob = {
  intent: string;
  spec_hash: string | null;
  spec_name: string | null;
  escrow: Step | null;
  delivery: Step | null;
  release: Step | null;
};

export type TokenAmount = { token: string; amount: string };

export type TopWorker = { wallet: string; paid_jobs: number; paid_sol: string; house: boolean };

export type Services = { faucet: ServiceState; demo_worker: ServiceState; filler: ServiceState };

export type Feed = {
  cluster: string;
  generated_at: string;
  program: string;
  last_event_at: string | null;
  stale: boolean;
  stale_since: string | null;
  stats: {
    open_jobs: number;
    paid_jobs_7d: number;
    workers_7d: number;
    paid_7d: TokenAmount[];
    house_paid_jobs_7d: number;
  };
  events: FeedEvent[];
  latest_paid_job: LatestPaidJob | null;
  top_workers: TopWorker[];
  services: Services;
};

export type Job = {
  slot: number;
  owner?: string;
  mint?: string;
  attestor?: string;
  spec_hash?: string;
  escrow?: Step;
  delivery?: Step;
  delivery_slot?: number;
};

export type Paid = { at: string; slot: number; intent: string; payee: string; token: string; raw: string; decimals: number; house: boolean };

export type Pending = { signature: string; slot: number; blockTime: number | null; tries?: number };

export type State = {
  version: 1;
  newest: string | null;
  pending: Pending[];
  events: FeedEvent[];
  paid: Paid[];
  jobs: Record<string, Job>;
  decimals: Record<string, number>;
  latest_paid_job: LatestPaidJob | null;
  latest_paid_slot?: number;
  open_jobs: number;
  services: Services;
  slow_at: number | null;
  stale_since: string | null;
  retry_at: number | null;
};

export function emptyState(): State {
  return {
    version: 1,
    newest: null,
    pending: [],
    events: [],
    paid: [],
    jobs: {},
    decimals: {},
    latest_paid_job: null,
    open_jobs: 0,
    services: { faucet: "unknown", demo_worker: "unknown", filler: "unknown" },
    slow_at: null,
    stale_since: null,
    retry_at: null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isState(value: unknown): value is State {
  return (
    isRecord(value) &&
    value["version"] === 1 &&
    Array.isArray(value["pending"]) &&
    Array.isArray(value["events"]) &&
    Array.isArray(value["paid"]) &&
    isRecord(value["jobs"]) &&
    isRecord(value["decimals"]) &&
    isRecord(value["services"]) &&
    typeof value["open_jobs"] === "number"
  );
}
