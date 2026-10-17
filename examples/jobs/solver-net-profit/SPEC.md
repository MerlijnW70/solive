# Job: count a fill's SOL cost against its profit

`decide` compares a fill's spread with the profit floor, but the fill's SOL cost (signature fees, priority fee and tip) is never taken off. It is only capped by `--max-sol-cost`. When an order pays out in wrapped SOL, the solver can send a fill that loses SOL once its cost is counted.

## Build

- `Strategy` takes an optional `solValue`: a map from an output mint to `{ raw, lamports }`, the raw units of that mint worth `lamports` lamports. Wrapped SOL is always worth its own lamports, 1 to 1, without an entry.
- After a fill's SOL cost is known, `tick` converts it into the output mint, rounding up, and skips the fill with `NET_BELOW_FLOOR` when `profit` minus that cost is below the floor. The skip reason states the profit, the cost and the floor.
- Fills in mints with no `solValue` entry are judged as today.
- `Report.filled` and `Report.sent` entries carry `cost`, the SOL cost in lamports, for every fill.
- `intent-engine solve` takes `--sol-value <mint>=<raw>/<lamports>,...`, with the syntax of `--issue`.

## Rules

- Keep every safety check the solver has today. This check only adds skips.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag and the wrapped SOL rule in `docs/solver.md` in at most three short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: a wrapped SOL fill whose spread covers the floor but not the floor plus its cost is skipped with `NET_BELOW_FLOOR`; one that covers both is sent; a tip raises the cost; a mint with a `solValue` entry is converted with rounding up; a mint without one is judged as today; `cost` is reported; `--sol-value` parsing and refusals.
3. A test in `packages/solver/test/solver.test.ts`, on its LiteSVM program, shows a wrapped SOL fill skipped for its cost that the solver would have sent before this change.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
