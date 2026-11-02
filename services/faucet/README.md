# Devnet faucet

`POST /api/drip` with `{ "address": "<base58 address>" }` sends 0.5 devnet SOL to a new wallet and answers once the transfer is confirmed. It refuses any node whose genesis hash is not devnet's.

- `FAUCET_RPC_URL`: the node url, default `https://api.devnet.solana.com`.
- `FAUCET_SECRET`: the faucet key as a JSON array of 64 bytes, read per request and never logged or returned.

| Status | Body | When |
|---|---|---|
| 200 | `{ "signature": "<base58>", "lamports": "500000000" }` | sent and confirmed |
| 400 | `{ "error": "<reason>" }` | missing or malformed address, or a body that is not that JSON |
| 405 | `{ "error": "<reason>" }` | any method other than POST |
| 429 | `{ "error": "<reason>", "retry_after": <seconds> }` | the address, the caller or the whole faucet is over its limit |
| 503 | `{ "error": "<reason>" }` | the faucet holds too little, or the node fails |

## Daily cap

The faucet sends at most 20 drips in any 24 hours, counted over all instances. Before it sends, it reads its own signature history from the node once, in pages of 100, and counts the successful transactions in the window. At 20 it answers 429, with `retry-after` set to when the 20th newest one leaves the window.

- Every successful transaction on the faucet address counts, so a refill into the faucet uses one slot. Failed transactions do not count.
- A window that holds more than 200 entries, failed ones included, refuses the same way with `retry_after` of one day.
- The check runs after the recipient checks, so a refused recipient costs no extra read. A node failure stays a 503.
- The cap is soft: two instances can both read 19 and both send, so a burst can pass it by a few drips.

## Log

Each request writes one line of JSON:

- `status`, and `signature` on a 200.
- `caller`, the first 16 hex characters of a sha256 over the faucet secret, the UTC day and the caller's address. The same caller has one mark per day and a new one the next day; the address is never logged and the mark cannot be reversed without the secret. Left out when no secret is set.
- `agent`, the first 80 characters of the `user-agent` header with control characters removed. Left out when the request has none.
