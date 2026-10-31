# Job: A live feed of the agent economy on devnet

Build the data half of a public page that shows Solive working live on devnet: jobs posted, work delivered, verdicts, payouts, swaps, the best workers, and whether the faucet, the demo worker and the filler are up. The owner hosts it on Vercel.

## Feed contract

`GET /api/feed` returns JSON, the same shape for every caller, at most `FEED_MAX_AGE_SECS = 30` old:

```json
{
  "cluster": "devnet",
  "generated_at": "<ISO 8601>",
  "program": "<base58>",
  "stats": { "open_jobs": 0, "paid_jobs_7d": 0, "paid_sol_7d": "0", "workers_7d": 0 },
  "events": [
    { "kind": "escrow | delivery | verdict | payout | swap", "at": "<ISO 8601>", "signature": "<base58>",
      "intent": "<base58>", "who": "<base58>", "amount": "<whole tokens>", "token": "SOL | TEST | <mint>",
      "detail": "<one plain sentence>" }
  ],
  "top_workers": [ { "wallet": "<base58>", "paid_jobs": 0, "paid_sol": "0" } ],
  "services": { "faucet": "up | down", "demo_worker": "up | down", "filler": "up | down" }
}
```

`events` is newest first, at most 50. Amounts are decimal strings in whole tokens. `detail` is plain text written by the feed, never text copied from a spec, a memo or a delivery.

## Build

1. **Function.** a new `feed.ts` under a new `api/` folder in a new `services/live/` package, a Vercel Node.js function, with the logic in plain modules in a `src/` folder of that package that tests import without Vercel. Use `@intent-engine/client` and `@intent-engine/core` from the workspace (or `@solana/kit` where they lack a read), the same versions the repository uses.
2. **Reads.** Read the program's recent activity from devnet (`FEED_RPC_URL`, default the public devnet url): escrows, announcements, attested releases and their payee, swaps filled. Derive `stats` and `top_workers` from the last 7 days.
3. **Cheap and fast.** Public devnet rate-limits a single IP quickly. Bound the number of RPC calls per refresh, cache the whole response in memory and with `Cache-Control: public, s-maxage=30, stale-while-revalidate=300`, and when a read fails serve the last good response with `stale: true` instead of an error.
4. **Services.** `faucet` is up when `https://solive-faucet.vercel.app/api/drip` answers a GET with 405; `demo_worker` and `filler` are up when their devnet wallets (`FEED_DEMO_WORKER`, `FEED_FILLER`, base58, default unset meaning unknown) sent a transaction within `SERVICE_WINDOW_SECS = 900`.
5. **Package.** A `package.json` for the new package, private, as a workspace package; add it to the workspace and to `scripts/ts-test.sh` like `services/faucet`. A `vercel.json` and a README of at most 15 lines.

## Tests

Against a stubbed transport: every event kind is read and shaped as the contract says; `detail` never contains spec, memo or delivery text; stats and top workers count the right window; the call budget holds; a failed read serves the last good response with `stale: true`; the cache header is set; the service checks map their inputs.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines. The product name comes from `identity.toml`, never hard-coded.
- Devnet only. No key, no signing, nothing sent: the feed only reads.
- Another worker builds the other half in parallel against the same contract; touch only `services/live/` and what this spec names.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
