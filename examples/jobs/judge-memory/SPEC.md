# Job: A memory kill fails the work only when the spec pins the memory and the work caused the kill (judge-memory)

**Rules:**
1. A memory kill fails the work only when the spec's judge-run or judge-cases block pins the memory, and only when the judge can show that the work caused the kill under that limit. A kill the judge cannot tie to the work under a pinned limit is infra, never fail.
2. The same cause gets the same outcome on the Docker route and on the plain Node route: pass, fail, infra or refused. Decide every outcome by `packages/cli/src/verdict-model.ts` and the outcome table in `docs/maintainers/judge-internals.md`.
3. A cheater must not be able to turn its own fail under a pinned limit into infra. An honest worker must never get a fail that the judge or the host caused.
4. Every exit code and message matches the exit-code table in `docs/judge.md`.

Today, from the last review:
- **Unpinned memory kills now fail.** Without a memory pin, the judge picks the memory limit itself. On the Docker route, `containerOutcome` in `verdict-model.ts` treats a container flagged `OOMKilled` that exits with a code other than 137 as `exitedWith(code)`, which is a fail. On the plain Node route, a case whose forked child was killed for memory, and which then exits non-zero, keeps its fail verdict, because `pinnedFill` returns nothing when no memory is pinned. Both charge honest work for a limit the judge chose. An unpinned kill of pid 1 is already infra, so this fail stops no cheat.
- **The launcher can be killed instead of the case.** Under a pin, a case that starts many small processes can make the kernel kill the plain Node launcher, the biggest process in the container. If Docker then does not set the flag, `pinnedLauncherEnd` returns infra (`launcherKilledPinned`). So under a pin a case can turn its own fail into infra.
- **Host kills counted as limit kills.** `oomCount` in `packages/cli/src/node-runner.ts` reads only `oom_kill` from `memory.events`. That counter also rises when the host's global out-of-memory killer kills a process in the container. So under a pin, a host kill can fail honest work. The `oom` counter rises only when the container's own limit is hit.
- **Temporary status codes.** `temporaryStatus` in `packages/cli/src/fetch-class.ts:9` treats every status of 500 and up as temporary, so 501 and 505 are retried and reported as temporary. `HTTP_LASTING` in `packages/cli/src/rpc-failure.ts` already treats them as lasting. `silentRefusal` in `packages/cli/src/faucet.ts:134` reports every status of 500 and up as "faucet down", including 501 and 505.

## Build

1. **Unpinned memory kills.** Without a memory pin, a memory kill of any process of the work, whether flagged by Docker or counted in `memory.events`, gives infra on both routes when the result would otherwise be fail. A result that passes stays a pass. Under a pin the outcome stays as it is today, apart from items 2 and 3. Name every input the decision reads. Show why this does not let work turn a fail into infra under a pin.
2. **Launcher before case.** Make the kernel pick a process of the case before the launcher. For example, start the launcher container with a negative `--oom-score-adj`, and have each case raise its own score to 1000 in `/proc/self/oom_score_adj` before it imports any work. Show that the case process cannot lower its score again, and that a case starting many small hogs under a pin gives a fail, not infra.
3. **Limit kills only.** Under a pin, the plain Node route fails a case for memory only when `oom` and `oom_kill` both rose during the case. When only `oom_kill` rose, the outcome is infra with a reason that says the kill may have come from the host. Read both counters in one read of the file. On the Docker route, decide whether the same residual exists for `OOMKilled`, state it, and document it in the outcome table.
4. **Status codes.** `temporaryStatus` treats 501 and 505 as lasting, matching `HTTP_LASTING`. Use one shared definition rather than two lists. `silentRefusal` does not call 501 or 505 "faucet down". Check every other place that classifies an HTTP status as temporary or lasting, and list it in the report.

## Tests

- **Unpinned:** on each route, a check that forks a memory hog and then exits 1 gives infra. A check whose hog is killed but that exits 0 passes. The Docker test may be gated on Docker, as the existing Docker tests are.
- **Pinned:** the same check under a memory pin still gives fail on both routes.
- **Launcher:** under a pin, a case that starts many small hogs gives fail, and the launcher is not the process killed. Gate on Docker if needed.
- **Counters:** a unit test where `oom_kill` rises and `oom` does not gives infra under a pin. A unit test where both rise gives fail.
- **Status codes:** one test each for 501 and 505 through `temporaryStatus` and through `silentRefusal`.
- **Mutants:** for items 1, 2 and 3, show that removing the fix fails a test.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Use `performance.now()` for any new wait.
- No program change. No change to a money rule.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- For each Build item: what changed, where, and the test that covers it.
- The full list of inputs the memory decision reads on each route.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms rules 1 to 4 on every route, and that no judge-caused or host-caused problem became a fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
