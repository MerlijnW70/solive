# Live feed

`GET /api/feed` returns one JSON document of the program's recent devnet activity, read only: no key, no signing, nothing sent. `public/` is the site root.

- `FEED_RPC_URL`: the node url, default `https://api.devnet.solana.com`; it may hold a key and never appears in a response or log.
- `FEED_HOUSE`: comma-separated base58 wallets whose activity is marked house.
- `FEED_FAUCET`, `FEED_DEMO_WORKER`, `FEED_FILLER`: base58 wallets for the service lights; unset reads `unknown`.

Each refresh lists new program signatures with `until` set to the newest one seen, reads at most `FEED_TRANSACTIONS_PER_REFRESH` transactions and decodes events from their inner instructions. Open jobs and service lights are read every `FEED_ACCOUNTS_EVERY_SECS`.

While the state's history does not reach `PAID_WINDOW_SECS` back, a refresh with reads to spare lists older program signatures with `before`, after it has read the new ones, and queues those inside the window behind them, oldest first. That listing takes one of the refresh's transaction reads. A release read before its escrow, while its token is still unknown, is counted once the escrow is read.

The state keeps the oldest signature listed, so the next refresh resumes there. The backfill ends at a signature older than the window or at the program's first one.

`history.since` in the JSON is the time of the oldest signature listed so far. `history.complete` is true once the backfill has ended and its queue is read, whatever new activity still waits; until then the page marks the seven-day figures as still filling. A feed without `history` reads as complete.

State lives in the Vercel Runtime Cache, written only when it changes, with an in-memory copy as fallback. It is saved under the key `live-feed-state-v2` with `version: 2`. A missing entry, or one under another key or version, reads as empty state, so a new build backfills from scratch and names workers by wallet; meanwhile the page shows the figures as still filling. On a 429 or a timeout the feed serves its last state with `stale: true` and waits the `retry-after` seconds before reading again.
