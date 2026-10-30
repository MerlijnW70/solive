# Job: A devnet faucet service that funds a new wallet at once

A first-time user gets a wallet with no SOL and is stuck: devnet airdrops usually fail, and this project's faucet answers a GitHub issue only a few times an hour. Build a small HTTP faucet that sends devnet SOL to a new wallet within seconds. It is hosted on Vercel by the owner; you write the code and tests, never deploy, and never handle a real key.

## Contract

`POST /api/drip` with JSON body `{ "address": "<base58 address>" }`.

| Status | Body | When |
|---|---|---|
| 200 | `{ "signature": "<base58>", "lamports": "500000000" }` | sent and confirmed |
| 400 | `{ "error": "<reason>" }` | missing or malformed address, or a body that is not that JSON |
| 405 | `{ "error": "<reason>" }` | any method other than POST |
| 429 | `{ "error": "<reason>", "retry_after": <seconds> }` | the address or the caller is over its limit |
| 503 | `{ "error": "<reason>" }` | the faucet holds too little, or the node fails |

`lamports` is a decimal string. Every error reason is one plain sentence a user can act on.

## Rules

1. **Devnet only.** The RPC url comes from `FAUCET_RPC_URL`, default `https://api.devnet.solana.com`. Before any send, the node's genesis hash must equal devnet's (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`); anything else is a 503 and nothing is sent.
2. **Key.** The faucet key is a JSON byte array of 64 bytes in `FAUCET_SECRET`. It is read only at request time, never logged, never returned, never written to disk.
3. **Amount.** Exactly 0.5 SOL (`500000000` lamports) per drip.
4. **Who gets SOL.** Refuse (429) an address that already holds 0.25 SOL or more, and an address that received a drip from this faucet within `DRIP_WINDOW_SECS = 86400`. Decide the second from the chain (for example the address's recent signatures and their transactions), not from memory alone, so it holds across serverless instances.
5. **Caller limit.** At most `CALLER_DRIPS = 3` drips per caller IP per `DRIP_WINDOW_SECS` inside one instance (the owner adds a firewall rate limit in front). Read the IP from `x-forwarded-for` (first entry), else `x-real-ip`.
6. **Floor.** When the faucet holds less than 2 SOL plus the drip, answer 503 and send nothing.
7. **Confirm.** Return 200 only after the transfer is confirmed; a send that fails or does not confirm within `CONFIRM_TIMEOUT_MS = 30000` is a 503 that names the signature when there is one.

## Build

- Code under `services/faucet/`, TypeScript, as a Vercel Node.js function at `services/faucet/api/drip.ts`, with the logic in plain modules that tests import without Vercel.
- Use `@solana/kit` at the version the repository already uses. No new runtime dependency beyond what the function needs to run.
- Add `services/faucet` to the pnpm workspace and make `scripts/ts-test.sh` build, typecheck and test it like the other packages.
- Tests with a stubbed RPC cover every row of the contract and every rule above, including: a wrong genesis hash sends nothing, the key never appears in any response or log line, a recent drip is found on chain, the floor, the confirm timeout, and a malformed address.
- A `services/faucet/README.md` of at most 15 lines: what it does, the two env vars, and the contract table.

## Rules for the work

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Product names follow the existing identity rules.
- Do not change `packages/`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A code review finds every contract row and rule implemented and tested as written, with no path that sends on a cluster other than devnet or exposes the key.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
