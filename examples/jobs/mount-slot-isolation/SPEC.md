# Job: Mount slot tests and waits hold under concurrent judges (mount-slot-isolation)

**Rules:**
1. The mount slot tests give the same result whatever else runs on the machine, including other judges and other test runs under the same user.
2. A judge's lock wait never ends early because of another process's slot or lock, and never signals a process it did not start.

`packages/cli/test/judge-mount-slots.test.ts:202` ("stops waiting for a lock holder that does not end...") failed in three full CI runs on 2026-11-06 while other judge test runs and a program build shared the machine. It expected at least `SLOT_WAIT_MS - 100` and got less. The same test fails at base `36b54e4a`. Slots live under one per-user base (`packages/cli/src/artifact.ts:113`, `mountBase`), so concurrent processes share them. The test picks a holder through `holderOf(process.pid)` and assumes it holds the slot that this test's `removeCopy` releases.

These are leads, not a diagnosis. Find the real cause first and prove it.

## Build

1. **Find the cause.** Reproduce the failure on purpose, for example by running a second judge or test process that takes slots while the test runs. Show which assumption breaks: the test's, the product's, or both. Put the reproduction script and its output in the report.
2. **Fix the product if it is at fault.** If a judge can wait less than its bound, release another process's slot, or signal outside its own group because another process holds slots, fix it in `packages/cli/src/artifact.ts`. Keep the existing guarantees: slots, the fallback to a fresh directory, wiping a killed judge's slot without following symlinks, and the signal-scope rules from commit `d91f757b`.
3. **Fix the tests.** Every mount slot test runs against slots that only it controls, for example a per-test base the product accepts through an option the tests set. It must not depend on timing under load beyond the bound under test. Find every other test that uses the shared mount base (grep `mountBase`, `slotLock`, `slot-`) and apply the same isolation.

## Tests

- **A concurrency test:** while another process holds and releases slots under the same user, the judge's wait still meets its bound and releases only its own slot.
- **The slot suite and every test from item 3** pass 20 times in a row, under the concurrent load from item 1. Report the loop output.
- **The existing suites** of every package you change still pass. Do not weaken any assertion; widening a timing bound is not a fix.

## Self-check before delivering

- Find another route to the same hole: another test file, a judge process in another worktree, Docker Desktop's mount sharing, a stale lock file from a killed run.
- Can the isolation option reach production use and weaken slot sharing there?

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, and never export `GIT_DIR` or `GIT_WORK_TREE` around test runs.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Report

- The cause, with the reproduction.
- The changes.
- The 20-run loop output.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, also while another judge test run uses the machine.
2. A review confirms the cause is proven and fixed, not hidden by wider bounds.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
