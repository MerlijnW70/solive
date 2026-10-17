# Job: show what each solver scan did

`intent-engine solve --watch` prints a line only when a fill is sent or fails. Nobody can see how many orders it looked at, how many quotes it asked for, how often the quote cache answered, or why orders were skipped.

## Build

- `intent-engine solve --watch --stats` prints one JSON line after every full scan: `{ "at", "scan": "full", "stats": { "orders", "planned", "quotes", "cached", "filled", "sent", "failed", "skipped", "ms" } }`.
- `orders` counts the intents the scan listed, and `planned` the ones that reached a quote. `quotes` counts quote requests the wrapped pricer answered, and `cached` the ones the quote cache answered. `ms` is the scan's time in milliseconds.
- `skipped` maps each skip reason to its count, with every run of digits in the reason replaced by `#`.
- `cachedPricer` exposes `stats()` returning `{ hits, misses }` since it was made. A pricer wrapper `countingPricer(pricer)` exposes `count()`.
- Without `--stats` the output is as today. `--stats` needs `--watch`.

## Rules

- Counting never changes what the solver fills or sends.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/solver.md` in at most two short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use stubs and a stub clock. They cover: one stats line per full scan and none for a changed-only scan; each count matches a scan with known orders, quotes, cache hits, fills and skips; skip reasons that differ only in numbers share one key; `cachedPricer` hits and misses; `countingPricer`; no stats without `--stats`; `--stats` without `--watch` is refused.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
