# Job: wait for a better price on a falling auction

A Dutch auction asks less and less until `endTs`. The solver fills one as soon as its profit reaches the floor, although waiting a little would often pay more.

## Build

- `Strategy` takes an optional `target`, a map from an output mint to a profit target in raw units, and `patience`, a number of seconds that defaults to 30.
- For a Dutch auction in a mint with a target, `decide` skips with `WAITING_FOR_TARGET` while its profit is below the target and its asked amount is still falling more than `patience` seconds from now, that is while `now + patience < endTs`. The reason states the profit and the target.
- Once `now + patience >= endTs`, or once the profit reaches the target, the auction is judged against the floor as today.
- Other kinds of order, and mints without a target, are judged as today.
- `intent-engine solve` takes `--target-profit <output mint=raw,...>`, with the syntax of `--min-profit`, and `--patience <seconds>`, from 0 to 3600. A target below that mint's floor is refused, and `--patience` needs `--target-profit`.

## Rules

- Keep every safety check the solver has today. Waiting only adds skips.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flags in `docs/solver.md` in at most three short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use a fixed `now`. They cover: a Dutch auction below target is skipped with `WAITING_FOR_TARGET` early in its fall; the same auction fills once it reaches the target; it fills at the floor once `now + patience >= endTs`; after `endTs` it is judged as today; a swap order and a mint without a target are judged as today; flag parsing and refusals.
3. A test in `packages/solver/test/solver.test.ts`, on its LiteSVM program, waits on a real Dutch auction at an early clock and fills it at a later clock, where it pays more.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
