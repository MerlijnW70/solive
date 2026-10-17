# Job: a solver that plans orders in parallel

`tick` in `packages/solver/src/solver.ts` handles open orders one at a time. Each order waits on several RPC reads and a price quote before the next one starts, so one slow order delays all the others.

## Build

- `tick` plans orders concurrently, at most `concurrency` at a time. Planning covers everything before the simulation: standing, backoff, token programs, accounts, quotes, the route-size retries and compiling. `SolverOptions` takes `concurrency`, which defaults to 4 and must be an integer from 1 to 32.
- Simulating and sending stay one order at a time. Planned fills are simulated and sent in priority order: highest `profit` first, ties going to the soonest `expiresAt`, then the lowest address.
- On `RateLimited`, no new plans start. Plans already running finish. Every order not yet planned is reported as skipped with the rate-limit reason, as today.
- With `concurrency` 1 the report equals today's report for the same chain and pricer.
- `intent-engine solve` takes `--concurrency <n>` with the same default and bounds.

## Rules

- Keep every safety check `tick` has today: the simulation, the balance check, the SOL cost and rent caps, and backoff. Never send two fills for one order in one tick.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/solver.md` in at most two short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use stubbed chains and pricers with controlled delays, and no real sleeps. They cover: no more than `concurrency` plans in flight; sends happen one at a time in the priority order; a rate limit stops new plans while running plans finish; `concurrency` 1 matches the sequential report; bad `--concurrency` values are refused.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
