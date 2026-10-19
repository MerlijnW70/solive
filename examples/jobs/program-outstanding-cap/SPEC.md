# Job: cap what the program holds per mint (T-53)

A mint cap limits how fast escrow grows per window, not how much stays outstanding: intents from earlier windows stay escrowed until they settle, so the total the program holds per mint is unbounded (threat-model row T-53, `programs/intent_engine/src/caps.rs`). Solive has no users yet, so the mint cap account layout may change.

## Build

- A mint cap gains a total limit and a running outstanding amount. Every create adds its escrow to the outstanding amount and is refused, with a new named error, when that would pass the total limit; every fill, release, cancel, expire and close that moves escrow out subtracts exactly what left.
- `set-mint-cap` sets the total limit (zero meaning no total limit), through the existing admin and multisig path.
- The outstanding amount can never underflow, can never exceed what the program actually holds for that mint, and returns to zero when every intent of that mint is gone.
- `show mint-cap` and the monitor show the outstanding amount and the limit.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update the T-53 row, the mint-cap section of `docs/maintainers/operations.md`, and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: a create that would pass the total limit is refused; each way escrow leaves lowers the outstanding amount by exactly what left, including partial fills and splits; a property test over random sequences of creates and exits keeps the outstanding amount equal to the sum of open escrows of that mint; and a limit of zero imposes none.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
