# Job: Make the multisig tool refuse a proposal that closes the engine program

Catalog round H13 found that the multisig review (packages/multisig/src/review.ts) shows an upgradeable-loader Close instruction only as "Loader Close with N accounts". When that instruction closes the engine program's data, the program can never run again and every escrow vault it owns is locked for good, the pattern behind the OptiFi incident. `approve` and `execute` sign such a proposal without any warning. Closing a buffer the vault owns, after an aborted upgrade, is a normal and safe use of the same instruction.

## Required

1. The review decodes the loader's Close instruction: which account it closes, who receives the lamports, the authority, and the program when one is named. It says in plain words whether the closed account is a buffer or a program's data, and when it is the engine program's data it says that the program can never run again and every escrow it holds is locked for good.
2. `approve` and `execute` refuse a proposal that closes the engine program's data, as they refuse a proposal they cannot decode, unless the member passes a new explicit flag whose name says what it allows; `show` always prints the warning. Closing a buffer is shown and allowed as before.
3. The engine's program address and program data address come from the same source the review already uses for upgrades, so a proposal against another program is described but not refused.
4. docs/maintainers/operations.md documents the refusal and the flag beside the upgrade steps; the generated CLI references are regenerated with the repository's own script if they change.
5. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only packages/multisig, its docs and generated references. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test shows `approve` refusing a proposal that closes the engine program's data without the flag and accepting it with the flag; another shows a buffer close approved without the flag.
3. A test fails when the judge makes the review describe a program-data close as a plain loader instruction again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
