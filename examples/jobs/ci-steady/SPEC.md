# Job: Two causes of red CI that are not bugs (C1)

Two recent GitHub CI failures came from the runner, not the code.

1. `packages/client/test/spec-publish.test.ts`, "answers 403 without an open escrow, so nothing is stored and the reason says so", gives real HTTP through the real mirror handler a `budgetMs` of 100. On a slow runner the budget ends first, and the reason is `SPEC_PUBLISH_OVER` in place of "answered 403".
2. The `check` job in `.github/workflows/ci.yml` failed compiling the Rust tests with `No space left on device`, and the linker died with a bus error. The workflow has no step that frees disk space.

## Build

1. Make that test independent of runner speed while still checking the same behaviour: a real handler, a 403, the reason says so, nothing stored. Check the other tests in `packages/client/test` and `packages/cli/test` that use `budgetMs` or a real server with a budget under about a second, and fix any with the same race. Report each one. A test of the budget itself keeps a small budget where its outcome does not depend on speed.
2. Free disk space in the `check` job before it builds, the smallest way that holds: remove large preinstalled toolsets the job does not use, or lower debug info for its test builds, and print `df -h` before and after. Say what you chose, what it saves if you can measure it, and what you could not measure. Do not drop any test or check from the job, and keep every action pinned by commit hash as the workflow does.

## Tests

The named test passes with its fix under a slowed handler, shown by a run with an added delay greater than the old budget, and fails if the behaviour it checks is reverted. `bash scripts/ci.sh` still passes. Any test in the repository that pins the workflow's contents still holds.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No change under any `src` folder. No published package changes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
