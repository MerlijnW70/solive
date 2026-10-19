# Job: sealed real-input cases judged once (T-77, T-43)

`judge --sandbox viper` checks published cases and cases drawn from a public generator (`packages/cli/src/viper.ts`, `packages/cli/src/draw.ts`), so a delivery that recognises the generator's distribution can pass and still fail on the inputs the hirer really uses (threat-model rows T-77, T-43). Background research: `examples/jobs/r-distribution-split` and its report.

## Build

- The `judge-cases` block takes an optional `held`: `{ "sha256": "<64 hex>", "count": m, "url": "<https url>", "at": S, "domain": "<module source>" }`. The url serves a JSON array of `m` entries `{ args, expected? }`, sealed with the existing `seal` to the judge (or to each committee member); `sha256` is the hash of that plaintext, so it is fixed by the spec hash in the escrow.
- Before slot `S` the judge judges published and drawn cases as today but releases nothing; deliveries that pass are queued by announcement order.
- After the first finalized block at or after `S` the judge opens the held file, checks its hash, refuses the spec as the spec's fault if any entry fails `domain` (nothing paid), then runs the queued deliveries in order on every held case in fresh engines with the spec's budgets and releases to the first that passes all of them. An entry without `expected` is checked with the spec's `draw` checker.
- The held result is one bit: the verdict records `held: { count, passed, slot }` and never a failing index, input, answer or detail.
- `create attested` refuses a spec with `held` whose escrow expires too soon after `S` for judging to finish, naming the margin.

## Rules

- Single-key judges only in this job; a committee escrow with `held` is refused with a clear message.
- Reuse the ViperJS runner, the draw checker, the finalized-block wait and `seal`/`unseal`; do not duplicate them.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Document `held` in `docs/judge.md` in at most six sentences, update the T-77 and T-43 rows, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a delivery correct only on generator-shaped inputs passes the drawn cases but fails the held ones and is not paid; a correct delivery is paid only after `S`; a held entry outside `domain` refuses the spec; a wrong held-file hash refuses the spec; the verdict carries no held-case detail; and a spec without `held` behaves as today.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
