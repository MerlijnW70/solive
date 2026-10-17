# Job: one Jito bundle per tick

With `--jito`, `intent-engine solve` sends every fill as its own bundle, and every fill pays its own tip. A tick that fills several orders pays several tips and makes several bundle requests.

## Build

- `SolverOptions` takes an optional `sendBundle(wires)` that returns a bundle id. When it is set, `tick` collects the fills that pass every check instead of sending them one by one, and sends them at the end of the tick in bundles of at most `bundleSize` transactions. `bundleSize` defaults to `MAX_BUNDLE` and must be an integer from 1 to `MAX_BUNDLE`.
- Only the last transaction of each bundle carries the tip. Each transaction is checked as it will be sent: one built without the tip is compiled, simulated and costed without it.
- Every fill in a bundle is reported in `sent` with the bundle id as its signature. When a bundle request fails, every fill in it is reported in `failed` with the error.
- Without `sendBundle`, `tick` sends as today.
- `intent-engine solve --jito <url>` sends through `sendBundle`, and takes `--bundle-size <n>` with the same default and bounds. `--bundle-size` needs `--jito`.

## Rules

- Keep every safety check the solver has today, for every transaction in a bundle.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/solver.md` in at most two short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: three fills go out as one bundle with exactly one tip, on the last transaction; seven fills with `bundleSize` 5 go out as two bundles; a fill that fails its checks stays out of the bundle; a failed bundle request reports each of its fills as failed; without `sendBundle` nothing changes; bad `--bundle-size` values and `--bundle-size` without `--jito` are refused.
3. A test in `packages/solver/test/solver.test.ts`, on its LiteSVM program, lands a bundle's transactions in order and checks every receiver got at least its `required` and the tip was paid once.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
