# Live feed

`GET /api/feed` returns one JSON document of the program's recent devnet activity, read only: no key, no signing, nothing sent. `public/` is the site root.

- `FEED_RPC_URL`: the node url, default `https://api.devnet.solana.com`; it may hold a key and never appears in a response or log.
- `FEED_HOUSE`: comma-separated base58 wallets whose activity is marked house.
- `FEED_FAUCET`, `FEED_DEMO_WORKER`, `FEED_FILLER`: base58 wallets for the service lights; unset reads `unknown`.

Each refresh lists new program signatures with `until` set to the newest one seen, reads at most `FEED_TRANSACTIONS_PER_REFRESH` transactions and decodes events from their inner instructions. Open jobs and service lights are read every `FEED_ACCOUNTS_EVERY_SECS`.

State lives in the Vercel Runtime Cache, written only when it changes, with an in-memory copy as fallback. On a 429 or a timeout the feed serves its last state with `stale: true` and waits the `retry-after` seconds before reading again.
