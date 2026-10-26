# Job: The claim cooldown holds on every path that grants a claim

A worker who drops a claim (`drop_claim`) may not claim the same job again until the end of the time it held (`Cooldown` in crates/intent-core/src/claim.rs, `cooldown_of` in programs/intent_engine/src/claims.rs). `claim_job` checks this rule. The stand-by line does not:
- `stand_by` lets the current holder join its own line;
- `hand_over` in programs/intent_engine/src/claims.rs serves an entry without checking the cooldown.

So a holder near the end of its time can `stand_by` and then `drop_claim` in one transaction. That gets it the claim back at once with a fresh time, while a rival is refused with `ClaimHeld`. The test that shows this is below, under "The case".

## Required

1. One rule decides whether a worker may be granted the claim, for every path that grants it: `claim_job`, the hand-over in `drop_claim`, and `advance`. Put that rule in `intent-core`, beside `Cooldown`. Unit-test it there, and use it on each path.
2. `stand_by` refuses the worker that holds the claim, with a new named error appended to the engine errors.
3. If the line reaches an entry whose worker may not be granted the claim under that rule, the program does not serve it. The entry is closed, with its rent and stake going to its worker, and the line moves on to the next entry in the same instruction, exactly as it does for an entry already left. Account for every lamport.
4. No account layout changes. Regenerate the IDL, the generated client and the generated references, and add the error to the CLI's problem hints like the other engine errors.
5. Tests in `tests/svm`:
   - the case below, now refused;
   - a holder refused at `stand_by`;
   - a dropper's own entry skipped and refunded, with the next waiter served with its recorded time;
   - a dropper served normally once its cooldown has passed;
   - the existing two-wallet renewal in `standby.rs` behaving as before.
   Add rows for these to the claim section of docs/maintainers/catalog-classes.md, and a line to docs/maintainers/threat-model.md.

## The case

`examples/jobs/claim-cooldown-every-path/case.rs` is the test that shows the problem. Copied into `tests/svm/tests/` on `main`, it passes today. Turn it into a test that asserts the refusal.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Program and `intent-core` changes are allowed for this job. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 5 pass.
3. A test fails when the judge removes the cooldown check from the hand-over path.
4. A test fails when the judge removes the holder refusal from `stand_by`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
