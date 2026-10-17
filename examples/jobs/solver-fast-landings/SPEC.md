# Job: learn quickly whether a sent fill landed

`intent-engine solve --watch` keeps each sent fill in flight for `IN_FLIGHT_SECONDS` (90) before it checks whether the fill failed. A fill that failed on chain keeps its order out of the solver, and keeps its inventory held, for that whole time.

## Build

- `Transport` gains an optional `signatureStatuses(signatures)` that returns, for each signature, `"landed"`, `"failed"` or `null` when the node does not know it yet. The RPC transport in `packages/client` implements it with `getSignatureStatuses`, at most 256 signatures per call.
- On every scan, `watchSolve` asks once for the statuses of every fill still in flight. A landed fill leaves flight at once. A failed fill leaves flight at once, is reported in `failed` with `FAILED_ON_CHAIN`, and counts as a failure for backoff. Its hold ends with its flight. An unknown fill stays in flight until `IN_FLIGHT_SECONDS`, as today.
- Bundles sent through `--jito` are not asked about, as today.
- Without `signatureStatuses`, watch mode behaves as today.

## Rules

- Keep every safety check the solver has today. A fill whose status is unknown is never treated as failed.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- No new flag. Change only `packages/client`, `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: one status call per scan for all fills in flight; a landed fill leaves flight on the next scan; a failed fill leaves flight on the next scan, is reported once with `FAILED_ON_CHAIN`, counts for backoff, and frees its hold; an unknown fill stays until its flight ends; more than 256 signatures are split across calls; `--jito` fills are not asked about; a transport without `signatureStatuses` behaves as today.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
