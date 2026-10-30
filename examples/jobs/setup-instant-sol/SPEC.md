# Job: Setup funds a new devnet wallet from the instant faucet

`intent-engine setup` and the MCP tool `solive_wallet_setup` make a devnet wallet, then ask devnet for an airdrop, which usually fails. The user is left with an empty wallet. A new faucet service answers `POST /api/drip` (contract below) within seconds. Make setup use it, so a first-time user has SOL right away.

## Faucet contract

`POST <faucet url>/api/drip` with JSON body `{ "address": "<base58>" }`.

| Status | Body |
|---|---|
| 200 | `{ "signature": "<base58>", "lamports": "500000000" }` (confirmed) |
| 400, 405 | `{ "error": "<sentence>" }` |
| 429 | `{ "error": "<sentence>", "retry_after": <seconds> }` |
| 503 | `{ "error": "<sentence>" }` |

The default faucet url is `https://solive-faucet.vercel.app`. The environment variable `INTENT_ENGINE_FAUCET_URL` overrides it; the value `off` turns the faucet off.

## Build

1. **Order.** On devnet, when the wallet holds less than the amount setup already treats as enough to fund, setup asks the instant faucet first. Only if that gives nothing does it fall back to today's path: the devnet airdrop, then the GitHub faucet and the other faucets setup already names.
2. **Result.** Setup's output gains `faucet: { lamports, signature }` on a 200, or `faucet: { refused: "<the faucet's sentence>" }` otherwise, and the `next` text says plainly what happened and what to do next. A refused or unreachable faucet is never an error that stops setup.
3. **Safety.** Never call the faucet on any cluster other than devnet, and only over https (a `http://` url other than localhost is refused). Send only the address. Give up after `FAUCET_TIMEOUT_MS = 45000`. Treat the response body as untrusted data: show at most 200 printable characters of a refusal sentence.
4. **Both surfaces.** The CLI `setup` and the MCP `solive_wallet_setup` both get this, with the same output fields.
5. **Docs.** Update `docs/quickstart.md` "Devnet SOL" and `docs/ai.md` so the instant faucet comes first and the existing ways follow as fallbacks. Keep each paragraph under 80 words.

## Tests

Stubbed fetch and transport cover: a 200 funds and setup reports it; 429 and 503 fall back to the airdrop path with the refusal shown; a network failure and the timeout fall back; mainnet and a non-devnet url never call the faucet; `off` never calls it; an `http://` remote url is refused; a long or control-character refusal sentence is cut and escaped.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/cli` (and its tests) plus the two docs pages. Do not change `services/`.
- Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A code review finds every item above implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
