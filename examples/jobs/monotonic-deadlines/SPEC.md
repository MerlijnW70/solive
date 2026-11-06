# Job: Deadlines and elapsed time use a monotonic clock (monotonic-deadlines)

**Rules:**
1. Every deadline, timeout, budget, interval or elapsed time that starts and ends inside one process is measured with a monotonic clock (`performance.now()` or an injected clock that defaults to it). A step of the wall clock, backward or forward, never shortens, lengthens or ends such a wait.
2. Every time that is stored, shared with another process, compared with a file time, sent to or read from the chain, or shown as a date stays on the wall clock.

The wall clock in the WSL distro used for CI steps backward several times a minute. Waits measured with `Date.now()` then end early, run long, or fail, which is the root cause of several timing flakes in CI. Examples that look like rule 1:

- `packages/cli/src/judge.ts:382` — the viper judge's deadline;
- `packages/cli/src/agent/wallet/judge-work.ts:230` — the `judge_work` budget;
- `packages/cli/src/draw.ts:156` — the draw timeout;
- `packages/cli/src/agent/sales.ts:244` — a wait deadline;
- `packages/client/src/client-watch.ts:130` — the watch resync interval;
- `packages/cli/src/agent/budget.ts:58` — the rent cache lifetime;
- injected clocks that default to `Date.now`: `packages/solver/src/backoff.ts:19`, `packages/solver/src/remember.ts:33`, `packages/cli/src/main.ts:204`, `packages/cli/src/job-reads.ts:145`;
- service waits: `services/faucet/src/chain.ts:141` and `services/specs/src/sweep.ts:58`.

Examples that look like rule 2 and must stay: `packages/cli/src/agent/sales.ts:214` (file times), `packages/client/src/rpc-retry.ts:87` (an HTTP date), `packages/core/src/kinds.ts:322` and `packages/client/src/testing.ts:157` (chain time). Confirm or correct every classification.

## Build

1. **Classify every clock read** in `packages/*/src` and `services/*/src`: `Date.now`, `new Date()`, `performance.now`, and every injected `clock`, `now` or `time` parameter with its default. For each, name rule 1 or rule 2 and say why. Where one value serves both (for example a time that is both stored and used as a deadline), split it into two values.
2. **Fix every rule 1 site.** Use one small shared helper per package where that avoids repetition, and keep injected clocks injectable so tests stay fast and deterministic. Do not change any timeout value, retry count or limit.
3. **Tests that measure time.** Find every test in the repo that measures elapsed time or waits for a deadline with `Date.now()`, where a wall-clock step could make it fail or pass wrongly. Move each to `performance.now()` or to an injected fake clock. Do not raise any timeout, and do not loosen any bound.

## Tests

- For each fixed product site, one test with an injected clock: a wall clock that steps backward or forward during the wait does not change when the wait ends. Group these by file where that is natural.
- One test per package that the production default is monotonic, so the fix cannot be undone by a default.
- The existing suites of every package you change still pass. Do not weaken any assertion.

## Self-check before delivering

- Is any value that is persisted, shared or compared with a file time or chain time now monotonic? It must not be.
- Can any deadline now never end, for example a monotonic start compared with a wall-clock end?
- Run `grep -rn "Date.now" packages/*/src services/*/src` and account for every remaining line in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No change to any timeout value, limit or user-visible text.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- The classification table: `path:line — rule 1 or 2 — why`.
- The changes.
- The tests that measure time, before and after.
- **Same defect elsewhere:** `path:line — why`, for anything outside the scope above, such as scripts or the program's test harness.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that no rule 2 value became monotonic and no rule 1 wait still reads the wall clock.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
