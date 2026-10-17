# Job: a solver that stops asking for prices it already knows

`intent-engine solve --watch` scans every open order every few seconds. An order that cannot be filled yet, such as a falling-price auction still above the market, gets a new price quote on every scan. Those quotes win nothing and use up the aggregator's rate limit.

## Build

- `cachedPricer(pricer, { ttlMs, clock })` in `packages/solver/src` wraps any `Pricer`. It returns the stored quote for a request with the same input mint, output mint, `amountIn`, `taker` and `maxAccounts` while that quote is younger than `ttlMs`, and asks the wrapped pricer otherwise. A `null` result is stored too. A failed request is not stored.
- `QuoteRequest` takes an optional `fresh`. With `fresh: true`, `cachedPricer` asks the wrapped pricer and stores the new result.
- When `decide` would fill from a stored quote, `tick` asks again with `fresh: true` and builds the fill only from that fresh quote, deciding again with it. A fill is never built from a stored quote.
- `intent-engine solve --watch` wraps its pricer with a cache of `--quote-ttl <seconds>`, which defaults to 10; `0` turns the cache off. Without `--watch` there is no cache.

## Rules

- Keep every safety check `tick` has today.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/solver.md` in at most two short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use a stub clock, not real time. They cover: a repeat request inside the time limit asks the wrapped pricer once; an expired entry, a different `amountIn` and a different `maxAccounts` each ask again; `null` is stored and errors are not; `fresh: true` bypasses and refreshes; a fill decided from a stored quote is built only from a fresh quote, and is skipped when the fresh quote no longer pays; `--quote-ttl 0` and the default.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
