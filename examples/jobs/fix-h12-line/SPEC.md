# Job: close the two H12 findings on the stand-by line

Hunt round H12 found two breaks. Their tests are the patches in `hunt/` next to this file. Both are verified, and both fail on `main`.

- **NL-3:** after the upgrade, anyone can run `close_legacy` on a stand-by entry the old program wrote (version 0) while its escrow is still open. A later waiter uses this to remove an earlier entry and take the job ahead of it. `leave` forbids that, because only the entry's worker may leave while the escrow is open. Root cause: `close_legacy` closes outdated stand-by entries and claim boards without checking the escrow.
- **NX-2:** a worker can join the stand-by line while the guardian has paused the program, or when the escrow's kind has fills disabled, and so lock a new stake. `handle_stand_by` never reads the config, and neither does `claim_job`.

## Build

1. **`close_legacy` on line accounts.** `close_legacy` refuses a stand-by entry, and a claim board, whose intent is still open, with a new error that says to migrate it instead. Outdated line accounts of an open escrow are migrated in place, as `migrate` already allows. Once the escrow is no longer open, `close_legacy` works as now.
2. **Pause and disabled kinds.** `claim_job` and the stand-by join refuse while the program's fill pause is up, or while fills are disabled for the intent's kind, with the same errors a fill uses. Nothing that returns funds is affected: `leave`, drop, `advance`, cancel, expire, `settle_claims`, `close_legacy` and release still work while paused. Add a test that shows this.
3. **Regression tests.** Add the two hunt tests to `tests/svm/tests` under their invariant names. Change their expectations as needed so they pass, keeping the attack steps as they are.
4. **Docs and threat model.** Update the threat model: extend T-61 and T-74, or add a row, with the new tests. Update the pause description in `docs/maintainers/operations.md`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. The CLI and SDK must show the new refusals in plain words.
- Change only `programs`, `crates`, `tests`, `packages`, `idl` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Both hunt attacks are refused. The tests also show that a stand-by entry and a board of an open escrow migrate and keep their place in the line, and that every exit path works while paused.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
