# Job: Keep the test suite away from the real instant faucet (F2)

One full run of `scripts/ts-test.sh` sends one real request to `https://solive-faucet.vercel.app/api/drip`, measured by tracing `fetch`: `faucetFetch` (`packages/cli/src/main.ts`) through `askInstantFaucet` (`packages/cli/src/faucet.ts`) from `setup` (`packages/cli/src/wallet.ts`), reached by a test of the wallet setup tool on the devnet url. Each hit can cost the faucet 0.5 SOL and one slot of its daily cap, on every local run and every GitHub CI run.

## Build

1. Find the test or tests that reach it, and make them use a fake faucet fetch or `INTENT_ENGINE_FAUCET_URL=off`, keeping what each test checks.
2. Add a guard to the setup used by the test suite of `packages/cli`, `packages/client` and any other package that can reach this code: no test may reach the real faucet host. Set `INTENT_ENGINE_FAUCET_URL=off` for the whole run in a way spawned CLI processes inherit, and make any `fetch` to the faucet's production host fail the test that made it, with a message naming the host. Tests that pass their own faucet url or fetch keep working.
3. Production behaviour does not change: outside tests, `setup` asks the faucet exactly as today.

## Tests

Each fails if its behaviour breaks: a test that calls the real host through `fetch` fails with the guard's message, shown by a test of the guard itself; the environment default reaches a spawned process; `packages/cli/test/instant-faucet.test.ts` still passes unchanged in meaning; `setup` with no environment override outside the test setup still targets the default url. Show that a traced full run makes zero requests to the real host, and report how you measured it.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No change to anything under `src` unless it is needed and you say why. Tests never use the network.
- No file in `services/`. Another job is changing the spec reading and escrow files, so keep edits to them to the minimum this needs.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
