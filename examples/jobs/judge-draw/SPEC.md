# Job: test cases drawn after the work is announced (T-77, first step)

`judge --sandbox viper` runs a delivery against the cases published in the spec, so a delivery can answer them from a table, and the judge picks its own seed and clock (`packages/cli/src/viper.ts`, threat-model rows T-43, T-66, T-77).

## Build

- The spec's `judge-cases` block takes an optional `draw`: `{ "count": n, "generator": "<module source>", "checker": "<module source>", "k": K }`.
- The seed is the sha256 of a fixed tag, the blockhash of the first finalized non-skipped slot at or after the earliest announcement's slot plus `K`, the intent and the artifact's sha256. The judge waits for that slot to be finalized.
- The generator runs in a fresh ViperJS engine with only the seed and returns `n` argument lists of primitives; the delivery answers each in a fresh engine; the checker, in a fresh engine, gets the arguments and the answer and returns true or false.
- A pass needs every published case and every drawn case to pass. The verdict records the slot, the blockhash and the seed, so anyone with the spec and a full-ledger node regenerates the same cases.
- A spec without `draw` is judged exactly as today.

## Rules

- Reuse the ViperJS runner, its budgets and its limits (`MAX_CASES`, `MAX_ARGUMENTS`); the generator and checker get the same budgets as a delivery.
- A spec whose generator or checker fails, or returns something invalid, is refused as the spec's fault, never paid and never blamed on the worker.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Document `draw` in `docs/judge.md` in at most five sentences, update the T-77 row's evidence in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages/cli`, `packages/client` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a delivery that answers only the published cases from a table fails the drawn ones; a correct delivery passes; two judges derive identical cases from the same announcement; a different blockhash gives different cases; a broken generator or checker refuses the spec; and a spec without `draw` behaves as today.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
