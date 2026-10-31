# Job: The live feed of the agent economy on devnet

Build the data half of Solive Live, a public page that shows Solive working on devnet. The research behind it is `docs/maintainers/live-page.md` in this commit: read it first. Its sections "Data on devnet", "Architecture", "Trust rules" and "Changes to the draft specs" (the part for `live-feed`) are part of this spec.

## Contract

`GET /api/feed` returns one JSON document, the same for every caller, with exactly the shape described in item 1 of "Changes to the draft specs" for `live-feed`: `cluster`, `generated_at`, `program`, `last_event_at`, `stale`, `stale_since`, `stats` (`open_jobs`, `paid_jobs_7d`, `workers_7d`, `paid_7d` as a list of `{ token, amount }`, `house_paid_jobs_7d`), `events` (newest first, at most 50, kinds `escrow | claim | delivery | release | refund | swap`, each with `at`, `slot`, `signature`, `intent`, `who`, `amount`, `token`, `house`, `spec_hash`, `spec_name`, `detail`, and for `release` also `payee` and `attestor`), `latest_paid_job`, `top_workers` (with `house`), and `services` (`faucet`, `demo_worker`, `filler`, each `up | down | unknown`). Amounts are decimal strings in whole tokens. `detail` is a sentence the feed writes from event fields; no user-written text ever appears.

## Build

1. A new private workspace package named live under `services/`, with a Vercel Node.js function `feed.ts` in its `api/` folder and the logic in plain modules in its `src/` folder that tests import without Vercel; add it to the workspace and to `scripts/ts-test.sh` like `services/faucet`; a `vercel.json` and a README of at most 15 lines.
2. Implement items 2 to 8 of "Changes to the draft specs" for `live-feed` exactly: inner-instruction event decoding with the core parser, the `until` cursor, the named call-budget constants, 429 handling with `retry-after`, Runtime Cache state written only on change with an in-memory fallback, the two cache headers, `FEED_HOUSE` house marking, the service checks with `FEED_FAUCET`, `FEED_DEMO_WORKER` and `FEED_FILLER`, and no secret from `FEED_RPC_URL` in any response or log.
3. `spec_name` comes only from the catalog of demo spec hashes in `examples/demo/`.

## Tests

Every test in item 9 of "Changes to the draft specs" for `live-feed`, against a stubbed transport, plus: every event kind shaped as the contract says, and `detail` never containing spec, memo, delivery or profile text.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, and one real `/api/feed` response from devnet reads, included in the report, matches the contract.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines. The product name comes from `identity.toml`, never hard-coded.
- Devnet only. No key, no signing, nothing sent: the feed only reads. Public devnet rate-limits one IP and other services on this machine share it: keep live reads during development few and spaced out.
- Another worker builds the other half in parallel against the same contract; touch only the files this spec names.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
