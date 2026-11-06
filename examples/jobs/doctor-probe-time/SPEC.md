# Job: Sandbox doctor tests do not wait on real time (doctor-probe-time)

**Rule:** a test that drives `sandbox doctor` against a scripted docker never waits on real time for a probe whose outcome the script decides. The doctor's real probe limits stay as they are for real use.

`packages/cli/test/kill-cli-judge-survivors-doctor.test.ts` hit vitest's default test timeout in three full CI runs on 2026-11-06 under machine load. The file is slow even alone, at both `97f668ec` and `1c78945c`. A likely cause is the time probe: `sleep 600` under `TIMEOUT_PROBE_SECONDS` (`packages/cli/src/sandbox-doctor.ts:57`, used at `packages/cli/src/sandbox-doctor.ts:183`), which waits that limit in real time per doctor run even when the scripted docker answers at once. Confirm or correct this by measuring each probe's time in a test run.

## Build

1. **Measure.** Time each probe in a doctor test run, and list every real wait in the doctor and its test helpers.
2. **Inject the limits.** Make the probe time limits (`PROBE_SECONDS`, `TIMEOUT_PROBE_SECONDS` and any other real wait found in item 1) an input of the doctor's internal entry point, defaulting to today's values. The CLI and every production caller keep the defaults. Tests with a scripted docker pass small values, so no test waits on a probe longer than the scripted docker takes to answer.
3. **Find every other test** that runs the doctor or `contained` against a scripted docker, and apply the same.

## Tests

- **Probe outcomes unchanged:** the existing doctor tests still assert the same outcomes.
- **One test that the CLI uses the default limits**, so injection cannot reach real use.
- **The doctor test file passes 20 times in a row** while another CPU-heavy process runs. Report each run's duration.
- **The existing suites** of every package you change still pass. Do not raise any vitest timeout and do not weaken any assertion.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No change to what `sandbox doctor` prints or how it judges.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, and never export `GIT_DIR` or `GIT_WORK_TREE` around test runs.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- The per-probe timings before and after.
- The changes.
- The 20-run output.
- **Same defect elsewhere:** `path:line — why`, for other tests that wait on real time for an outcome a fake decides.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms no production path can receive the shortened limits.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
