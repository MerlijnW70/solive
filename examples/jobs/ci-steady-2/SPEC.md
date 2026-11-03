# Job: CI goes red only for the code, and no private names in tracked files (D17)

The deep audit of the services and CI (A4 F6, F7, F8, F19, F20, F24, F25, F26) found these faults.

## Build

1. **No public mainnet RPC on every run.** `scripts/ts-test.sh` and the fetch scripts download two upgradeable programs from the public mainnet RPC on every CI job, with no cache, so a rate limit or a mainnet upgrade turns CI red without a code change. Cache them keyed on the pinned hashes (or ship them as pinned assets) and keep the hash check.
2. **A hung monitor fails.** `.github/workflows/monitor.yml` has no step timeout, so a hang ends "cancelled" at the job timeout and may not alert. Add a step timeout so a hang fails, and test it.
3. **Pins written once.** The agave version and hash are written four times across `ci.yml` and `faucet.yml`; keep one source and test that every use agrees. The docs build uses an unlocked `vitepress`; lock it and build the docs in CI.
4. **Outside services out of the merge gate where possible.** The anonymous Docker Hub pull and the newest-kit probe in the pack test can fail CI with no code change. Pin or authenticate the image pull, and run the newest-kit probe as a separate job that does not block merges.
5. **Rule gates cover every source.** `scripts/comments.sh` skips `.mts`, `.js` and `.css`, and no script enforces the file-size limit. Extend the comment check and add a line-count check to the lint.
6. **No private tool names.** Three tracked job specs under `examples/jobs` name a private tool's config file. Reword them without the name and add a check to the bans script that refuses that name in tracked files.
7. **No orphan scripts.** `scripts/compile.sh` and `scripts/cu-rebaseline.sh` are referenced nowhere. Remove the unused one, and name the rebaseline script in the compute-unit gate's error and in the operations doc.

## Tests

Each item has a test that fails without its fix: the program fetch uses the cache and still refuses a wrong hash; the monitor workflow test asserts the step timeout; all agave pins agree; a comment in a `.mts` file fails the comment check; a file over the limit fails the lint; the bans check fails on the old spec wording.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `.github/workflows`, `scripts`, the three spec files under `examples/jobs`, `docs/maintainers/operations.md`, `tests/svm/src/cu.rs` (error text only), root `package.json` and lockfile if needed, and `packages/cli/test` workflow and script tests. No program logic change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
