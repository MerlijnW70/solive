# Devnet faucet

`POST /api/drip` with `{ "address": "<base58 address>" }` sends 0.5 devnet SOL to a new wallet and answers once the transfer is confirmed. It refuses any node whose genesis hash is not devnet's.

- `FAUCET_RPC_URL`: the node url, default `https://api.devnet.solana.com`.
- `FAUCET_SECRET`: the faucet key as a JSON array of 64 bytes, read per request and never logged or returned.

| Status | Body | When |
|---|---|---|
| 200 | `{ "signature": "<base58>", "lamports": "500000000" }` | sent and confirmed |
| 400 | `{ "error": "<reason>" }` | missing or malformed address, or a body that is not that JSON |
| 405 | `{ "error": "<reason>" }` | any method other than POST |
| 429 | `{ "error": "<reason>", "retry_after": <seconds> }` | the address or the caller is over its limit |
| 503 | `{ "error": "<reason>" }` | the faucet holds too little, or the node fails |
