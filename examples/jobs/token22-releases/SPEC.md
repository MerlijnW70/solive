# Job: Run every release path on Token-2022 mints with allowed extensions

`tests/svm/tests/token22.rs` (`settles_every_path`) runs fill, cancel and expire on mints with the extensions the program allows: InterestBearing, ScaledUi, MetadataPointer and Freezable. The release paths that pay workers, `fill_attested`, `fill_attested_split` and the committee release, only run on plain Token-2022 mints (`tests/svm/tests/cases/attested.rs`). A release that misreads an extended mint's amount or account size would pay the wrong amount.

## Required

- Tests in `tests/svm` that, for each allowed extension, run an attested release, an attested split release and a committee release, and check every balance afterwards to the base unit: worker or workers, judge fee, protocol fee, escrow vault emptied and closed, rent returned.
- The same for a release with a claim stake held, so the stake goes to the right wallet.
- Reuse the existing world and mint builders in `tests/svm`; add helpers rather than copying them.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `tests/svm`. No change under `programs/` or `crates/`.
- If a release pays a wrong amount, stop and report the case with both amounts instead of changing the program.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The new tests run every release path for every allowed extension; the report lists the matrix with each test name.
3. The judge changes one expected amount in a new test by one base unit and the test fails.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
