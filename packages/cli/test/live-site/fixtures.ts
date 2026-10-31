export const PROGRAM = "GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU";
export const FIZZBUZZ_HASH = "638375b5fb917437e51237bfcbcf690bdb583eeac4ee2d07bd8e39e9d921ae70";
export const CUSTOM_HASH = "4b1e0c9d2f7a8e6b3c5d1f0a9e8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(seed: number, length: number): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += ALPHABET[x % ALPHABET.length];
  }
  return out;
}

export const signature = (seed: number): string => base58(seed, 88);
export const address = (seed: number): string => base58(seed + 7000, 44);

export const HIRER = address(1);
export const WORKER = address(2);
export const JUDGE = address(3);
export const DEMO_WORKER = address(4);
export const FILLER = address(5);
export const OUTSIDE_WORKER = address(6);
export const TEST_MINT = address(7);

export type Step = { signature: string; at: string; who: string; amount: string; token: string };

export type FeedEvent = {
  kind: string;
  at: string;
  slot: number;
  signature: string;
  intent: string;
  who: string;
  amount: string;
  token: string;
  house: boolean;
  spec_hash: string | null;
  spec_name: string | null;
  detail: string;
  payee?: string;
  attestor?: string;
};

export type Feed = {
  cluster: string;
  generated_at: string;
  program: string;
  last_event_at: string | null;
  stale: boolean;
  stale_since: string | null;
  stats: { open_jobs: number; paid_jobs_7d: number; workers_7d: number; paid_7d: { token: string; amount: string }[]; house_paid_jobs_7d: number };
  events: FeedEvent[];
  latest_paid_job: { intent: string; spec_hash: string; spec_name: string | null; escrow: Step | null; delivery: Step | null; release: Step | null } | null;
  top_workers: { wallet: string; paid_jobs: number; paid_sol: string; house: boolean }[];
  services: { faucet: string; demo_worker: string; filler: string };
};

const iso = (now: number, secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();

type Row = [kind: string, secondsAgo: number, who: string, amount: string, token: string, house: boolean, detail: string];

const ROWS: Row[] = [
  ["release", 50, JUDGE, "0.05", "SOL", false, "A judge passed the work and the escrow paid 0.05 SOL to the worker."],
  ["delivery", 95, WORKER, "0.05", "SOL", false, "A worker announced a delivery for a fizzbuzz demo job."],
  ["claim", 140, WORKER, "0.01", "SOL", false, "A worker claimed a fizzbuzz demo job with a 0.01 SOL stake."],
  ["escrow", 190, HIRER, "0.05", "SOL", false, "A hirer locked 0.05 SOL for a fizzbuzz demo job."],
  ["swap", 420, FILLER, "2.5", "TEST", true, "The filler filled a swap of 0.01 SOL for 2.5 TEST."],
  ["release", 900, HIRER, "0.02", "SOL", true, "A hirer judged its own job and the escrow paid 0.02 SOL to the demo worker."],
  ["delivery", 960, DEMO_WORKER, "0.02", "SOL", true, "The demo worker announced a delivery for a palindrome demo job."],
  ["escrow", 1010, HIRER, "0.02", "SOL", true, "A hirer locked 0.02 SOL for a palindrome demo job it judges itself."],
  ["refund", 3600, address(8), "0.1", "SOL", false, "An escrow expired unpaid and refunded 0.1 SOL to its hirer."],
  ["escrow", 5400, address(9), "40", "TEST", false, "A hirer locked 40 TEST for a custom job."],
  ["swap", 7200, address(10), "1.25", TEST_MINT, false, "A solver filled a limit order for 1.25 of a token mint."],
  ["release", 9000, address(11), "0.3", "SOL", false, "A committee of 2 judges passed the work and the escrow paid 0.3 SOL to the worker."],
];

function events(now: number, from: number): FeedEvent[] {
  return ROWS.map(([kind, ago, who, amount, token, house, detail], i) => {
    const event: FeedEvent = {
      kind,
      at: iso(now, ago + from),
      slot: 420000000 - i * 40,
      signature: signature(100 + i),
      intent: address(200 + (i >> 2)),
      who,
      amount,
      token,
      house,
      spec_hash: kind === "escrow" ? (i === 9 ? CUSTOM_HASH : FIZZBUZZ_HASH) : null,
      spec_name: kind === "escrow" && i !== 9 ? (i === 7 ? "palindrome" : "fizzbuzz") : null,
      detail,
    };
    if (kind === "release") {
      event.payee = house ? DEMO_WORKER : WORKER;
      event.attestor = who;
    }
    return event;
  });
}

function step(now: number, ago: number, seed: number, who: string, amount: string): Step {
  return { signature: signature(seed), at: iso(now, ago), who, amount, token: "SOL" };
}

export function fullFeed(now: number, from = 0): Feed {
  const list = events(now, from);
  return {
    cluster: "devnet",
    generated_at: iso(now, 12),
    program: PROGRAM,
    last_event_at: list[0]?.at ?? null,
    stale: false,
    stale_since: null,
    stats: { open_jobs: 7, paid_jobs_7d: 23, workers_7d: 5, paid_7d: [{ token: "SOL", amount: "1.42" }, { token: "TEST", amount: "380" }], house_paid_jobs_7d: 15 },
    events: list,
    latest_paid_job: {
      intent: address(200),
      spec_hash: FIZZBUZZ_HASH,
      spec_name: "fizzbuzz",
      escrow: step(now, 190 + from, 103, HIRER, "0.05"),
      delivery: step(now, 95 + from, 101, WORKER, "0.05"),
      release: step(now, 50 + from, 100, JUDGE, "0.05"),
    },
    top_workers: [
      { wallet: OUTSIDE_WORKER, paid_jobs: 4, paid_sol: "0.62", house: false },
      { wallet: WORKER, paid_jobs: 3, paid_sol: "0.15", house: false },
      { wallet: address(12), paid_jobs: 1, paid_sol: "0.3", house: false },
      { wallet: DEMO_WORKER, paid_jobs: 14, paid_sol: "0.28", house: true },
      { wallet: FILLER, paid_jobs: 1, paid_sol: "0.07", house: true },
    ],
    services: { faucet: "up", demo_worker: "up", filler: "unknown" },
  };
}

export function emptyFeed(now: number): Feed {
  return {
    cluster: "devnet",
    generated_at: iso(now, 8),
    program: PROGRAM,
    last_event_at: null,
    stale: false,
    stale_since: null,
    stats: { open_jobs: 0, paid_jobs_7d: 0, workers_7d: 0, paid_7d: [], house_paid_jobs_7d: 0 },
    events: [],
    latest_paid_job: null,
    top_workers: [],
    services: { faucet: "unknown", demo_worker: "unknown", filler: "unknown" },
  };
}

export function quietFeed(now: number): Feed {
  return fullFeed(now, 3 * 3600);
}

export function staleFeed(now: number): Feed {
  return { ...fullFeed(now), generated_at: iso(now, 260), stale: true, stale_since: iso(now, 250), services: { faucet: "down", demo_worker: "up", filler: "unknown" } };
}

export function houseFeed(now: number): Feed {
  const feed = fullFeed(now);
  return { ...feed, events: feed.events.filter((e) => e.house), top_workers: feed.top_workers.filter((w) => w.house), stats: { ...feed.stats, paid_jobs_7d: 15, house_paid_jobs_7d: 15 } };
}

export const FIXTURES: Record<string, (now: number) => Feed> = { full: fullFeed, empty: emptyFeed, quiet: quietFeed, stale: staleFeed, house: houseFeed };
