# Job: The solver's rate limits, ranking and cost floor match its docs (D9)

The deep audit of the solver (A1 M4, M5, M6, L38) found these faults in `packages/solver`.

## Build

1. **A node 429 halts, it does not punish orders.** The solver treats only its own Jupiter `RateLimited` as a halt. A node 429, whether the client's `RateLimited` or a raw 429 after the client's retries, is recorded as a failure of that intent and backs good orders off for many intervals. Treat a node rate limit like a Jupiter one: halt the tick and add no per-intent backoff.
2. **Most profitable first, across mints.** Fills are sorted by raw profit in base units of each intent's own output mint, so mints with different decimals or values are ranked arbitrarily, while `docs/solver.md` says most profitable first. Rank by value in lamports where the solver can price the mint, and within one mint by raw profit; say in the docs how mints without a price are ranked.
3. **The cost floor keys on the right mint.** `net.ts` nets SOL costs only when the output mint is wrapped SOL, while `docs/solver.md` says the mint the solver is paid in. Make code and docs agree on the mint the solver is actually paid in, and warn when `--min-profit` names a mint that has no way to be priced in SOL.
4. **Split `solver.ts`.** It is at the file-size limit; move order planning and fill sending into their own files without changing behaviour.

## Tests

Each item has a test that fails without its fix: a node 429 during planning halts the tick and adds no backoff; two mints with different decimals are ranked by value; the documented walkthrough nets its SOL cost; the warning appears for an unpriceable `--min-profit` mint.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/solver`, `docs/solver.md` and the CLI solve tests if an output changes. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
