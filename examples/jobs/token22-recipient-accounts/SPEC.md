# Job: Test every payout path against Token-2022 recipient account settings

`tests/svm/tests/token22_releases.rs` runs every release path on Token-2022 mints with the extensions the program allows. What is not covered is the receiving side: Token-2022 lets the owner of a token account turn on settings that change how transfers into it behave, and the program pays into accounts that belong to workers, judges, partners, the fee recipient and owners. Nobody has checked what each payout path does when one of those accounts has such a setting.

## Required

1. Tests in `tests/svm` for each payout path (attested release, attested split release, committee release, cancel and refund, expire, a held claim stake returned or forfeited, the partner and judge fees, and the protocol fee) where the receiving token account is a Token-2022 account with, one at a time: required memos on incoming transfers, the CPI guard, a frozen state, and the account closed before the payout. Use mints the program accepts.
2. Each test states the behaviour it finds and checks it exactly: either the payout completes with every balance correct to the base unit, or the instruction is refused with a named error and the escrow stays in a state from which it can still be released or refunded to someone.
3. A short table in docs/maintainers/catalog-classes.md (or a new section beside the existing Token-2022 rows) lists every path and setting with the test name and the behaviour found.
4. Reuse the existing world and mint builders in `tests/svm`; add helpers rather than copying them.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `tests/svm` and the docs table. No change under `programs/` or `crates/`.
- If a case leaves an escrow that can never be released or refunded to anyone, or lets the setting on one recipient's account stop the payout to other recipients, do not change the program: write that case as a separate test file outside the patch, describe it in the report with the amounts at stake, and keep the patch's own tests passing by asserting only what holds.

## Acceptance

1. `cargo test --workspace` and `bash scripts/ts-test.sh` pass with the patch applied to `main` at the commit the delivery names.
2. Every path and setting in Required 1 has a test, listed in the docs table and the report.
3. The judge changes one expected amount or one expected error in a new test and that test fails.

## Deliver

One `git format-patch` file, plus any separate case files from the second rule. Announce the patch's sha256 to the judge.
