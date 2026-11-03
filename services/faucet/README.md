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
| 503 | `{ "error": "<reason>" }` | the faucet holds too little, the node fails, or a send ended in an error |

## Deploy

The faucet is its own Vercel project with `services/faucet` as the root directory. Set `FAUCET_SECRET` in the project's environment, and `FAUCET_RPC_URL` only for another devnet node. From `services/faucet`, `vercel deploy --prod` publishes `public/` and `api/drip.ts`. A deploy changes what visitors see at once, so check `POST /api/drip` with an address that already holds 0.25 SOL: it answers 429 and sends nothing.

## Funding

The faucet pays from the wallet whose key `FAUCET_SECRET` holds: `932eKvgQTgn5gCsXyJ8p6cnXNpbvZgY3F1bw96QWhob5`. It refuses every drip while that wallet holds less than 2.5 SOL (`FLOOR_LAMPORTS`), so a day at the cap of 20 drips needs 12.5 SOL. The hourly monitor in `.github/workflows/monitor.yml` alerts below 13 SOL.

Two scripts refill wallets from a funding wallet, and each refills one:

- `scripts/faucet-topup.sh` refills the wallet in `TOPUP_FAUCET`, by default the issue faucet's `CrYx7JA1TRwGtpn9T6C2mVsRgMP7XztGRwZdasV9XSLS`. For this faucet run it with `TOPUP_FAUCET=932eKvgQTgn5gCsXyJ8p6cnXNpbvZgY3F1bw96QWhob5 TOPUP_FLOOR=13 TOPUP_TARGET=20`, once without `--yes` to preview the transfer.
- `scripts/faucet.sh` is the issue faucet's own sender; it never refills the instant faucet.

## Per address

An address gets one drip in any 24 hours, and none while it holds 0.25 SOL or more. The faucet reads the address's history from the node, so this holds across instances. The hold on an address whose drip is on its way lives in one instance's memory: two requests for the same address that reach two instances at the same moment can both send.

## Per network, per instance

These limits live in one function instance's memory, so they hold per instance, and a new instance starts with none:

- A network, the first `x-forwarded-for` address, gets at most 3 drips in 24 hours. A request that sent nothing does not count.
- A network gets at most 10 requests that reach the node in an hour, refusals included. Past that it answers 429 without reading the node.
- A refusal for an earlier drip or a busy history, and a drip just sent, are kept for 10 minutes, so the same address does not read the node again in that time.

## Daily cap

The faucet aims at 20 drips in any 24 hours over all instances, and each instance also stops at 20 of its own sends. At either limit it answers 429, with `retry-after` set to when the 20th newest drip leaves the window.

Every drip carries the memo `drip <recipient> <blockhash>`. The node lists that memo with each signature, so the faucet rebuilds the drip from it and checks the signature against its own key, with no transaction read. Before it sends, it reads its own signature history in pages of 1000 and counts the successful entries that pass this check.

- A transfer into the faucet, a refill, a failed transaction, or a copied memo under another signature does not count.
- One request reads at most 5 pages of 1000 entries and no transactions. When the window holds more, the count stops there.
- The per-instance limit lives in memory and counts only sends: a request takes a slot after every other check has passed, right before it sends, and gives it back when nothing was sent. A request that is refused never holds a slot, so outside requests fill it only with real drips. It covers what the chain count cannot see.
- The chain count relies on the node returning each signature's memo. A node that returns no memos leaves the per-instance limit as the only daily limit.
- The check runs after the recipient checks, so a refused recipient costs no extra read. A node failure stays a 503.
- The cap is soft: two instances can both read 19 and both send, so a burst can pass it by a few drips.
- Drips sent before the memo existed are not counted on chain.

A flood of foreign entries cannot shut the faucet: foreign entries never count, and they cost each request at most 5 page reads. It can open the chain count: more than 5000 entries in the window, newer than the drips, hide those drips. Then each instance still sends at most 20 a day, so the worst case is 20 drips a day for each instance the platform runs, within the per-address and per-network limits.

## Send errors

When the send itself ends in an error, the faucet checks the signature once. If the node shows the transfer, the faucet waits for it as usual. If the node refused it before sending, or it landed with an error, the answer says no SOL arrived. Otherwise the answer says the faucet cannot tell, names the signature to check in an explorer, and the request counts toward the network's 3 drips.

## Log

Each request writes one line of JSON:

- `status`, and `signature` on a 200.
- `caller`, the first 16 hex characters of a sha256 over the faucet secret, the UTC day and the caller's address. The same caller has one mark per day and a new one the next day; the address is never logged and the mark cannot be reversed without the secret. Left out when no secret is set.
- `agent`, the first 80 characters of the `user-agent` header with control characters removed. Left out when the request has none.
