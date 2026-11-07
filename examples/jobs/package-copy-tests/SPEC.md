# Job: Every package's tests run from a copy of that package alone (package-copy-tests)

**Rule:** the tests of each package under `packages/` pass when only that package's directory is copied to another place and `scripts/test.sh <repo root> test` runs there. Any path that leaves the package resolves from `INTENT_ENGINE_ROOT` when it is set, and falls back to the relative path when it is not. Many tests already follow this pattern, for example `packages/cli/test/binary.test.ts:45`.

Today:
- `bc61d238` added a shared global setup by relative path: `new URL("../cli/test/run-root-setup.ts", import.meta.url)` in:
  - `packages/core/vitest.setup.ts`;
  - `packages/solver/vitest.setup.ts`;
  - `packages/client/vitest.config.ts` (also `../cli/test/faucet-setup.ts`);
  - `packages/multisig/vitest.config.ts`.
- In a copied package these paths do not exist. Every test run there stops at once with `Failed to load url /tmp/cli/test/run-root-setup.ts`, code `ERR_LOAD_URL`.
- With those four paths patched by hand, more tests still fail in a copy:
  - `packages/solver/scripts/test.sh` never exports `INTENT_ENGINE_ROOT`, unlike the scripts of core, client and cli. So `packages/solver/test/raw-account-decodes.test.ts:6` and `packages/solver/test/solver-truth.test.ts:21` fall back to `/` and read `//docs/solver.md`;
  - `packages/core/test/event-names.test.ts:7` and `packages/core/test/intent-mandate-serial.test.ts:6` read files by relative path with no fallback;
  - `packages/client/test/spec-fallback.test.ts:237` reads `docs/` by relative path;
  - `packages/client/test/spec-publish.test.ts:7` and line 8 import `services/specs` by a static relative import. Choose a form that resolves from the root, and say why it is sound.
- Reproduce: copy `packages/solver` without `node_modules` to an empty temp directory, then run `bash scripts/test.sh <repo root> test` there. It exits 1. From inside the repo the same command passes.

## Build

1. Resolve every path that leaves the package by the rule above: in all vitest config and setup files, in every test or test helper under `packages/*/test`, and in imports. Every `scripts/test.sh` that takes the repo root exports `INTENT_ENGINE_ROOT`. Grep the whole repo for relative URLs and paths that climb out of their package, and list each one you fix in the report.
2. Add a test that keeps the rule. It scans the vitest config and setup files and the test files of every package. It fails on any relative path that climbs out of the package without the `INTENT_ENGINE_ROOT` fallback pattern. It names the file and line. Choose where it lives, and say why.
3. Packages without `scripts/test.sh` (such as `packages/multisig`) still follow rule 1 in their config. Do not add new scripts for them.

## Tests

- The new guard test fails on the tree as it is today, naming the files above, and passes after the fix. Show both runs in the report.
- Run the copied-package reproduction above for `core`, `solver`, `client` and `cli`, from a fresh temp directory each. Each exits 0. Put the commands and the last lines of output in the report.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No change to what any test checks, only to how it finds its files.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- Every path you changed: `path:line`, the old form and the new form.
- The guard test: where it lives, what it scans, and both runs.
- The four copied-package runs.
- **Same defect elsewhere:** `path:line — why`, for example scripts outside `packages/` that assume the repo layout.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The copied-package run passes for `core`, `solver`, `client` and `cli` on the judge's machine.
3. A review confirms that no test path leaves its package without the fallback, and that no assertion changed.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
