# Job: Claim stakes and refunds never fail on the rent rules

A claim stake (`open_claims` sets it, `claim_job` takes it) and a stand-by entry's stake are moved in lamports by `move_lamports` in programs/intent_engine/src/claims.rs. Several paths move only the stake (`held`):
- a release or cancel that refunds the holder;
- `drop_claim`;
- `settle_claims`;
- a lapsed stake paid to the owner by `claim_job`, `advance` or a release.

The runtime refuses a transaction that leaves a system account with a balance above zero but below the rent-exempt minimum. So a stake below that minimum, moved to a wallet holding zero lamports, may fail the whole instruction. For example, a holder that empties its wallet during its claim could then block the owner's cancel until the claim lapses. Round H16 raised this without a test.

## Required

1. Write tests in `tests/svm` for every path above with a stake below the rent-exempt minimum of a zero-byte account and a receiving wallet at zero lamports. Each test states what happens today.
2. Where a path fails, or lets one party block another's cancel, release, drop or settle, fix it at its cause in the program, with every lamport accounted for. If you choose a minimum stake, `open_claims` and `open_claims_listed` must refuse a stake above zero and below the minimum with a new named error appended to the engine errors. Then:
   - the SDK and CLI check it before signing;
   - the MCP open-claims tools explain it;
   - the tests show that no path can fail on rent afterwards, including a holder that empties its wallet.
   If you choose another fix, it must make the same guarantee, and the report says why it is better.
3. If every path already holds, the tests stay as the proof, and the docs say so.
4. Add rows to docs/maintainers/catalog-classes.md (claims) and a row to docs/maintainers/threat-model.md. Regenerate the IDL, the generated client and the references if the program changes.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Program and `intent-core` changes are allowed for this job.
- Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 1 pass on the patched program.
3. A test fails when the judge removes the fix (or, if no fix was needed, changes one expected lamport amount).

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
