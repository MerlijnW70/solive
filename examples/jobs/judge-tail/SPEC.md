# Job: The judge classifies the same cause the same way on every route (judge-tail)

**Rules:**
1. The same cause gets the same outcome on the Docker route and on the plain Node route: pass, fail, infra or refused. Decide every outcome by `packages/cli/src/verdict-model.ts` and the outcome table in `docs/maintainers/judge-internals.md`.
2. A run never leaves a process or a zombie behind: not in the container, not in the plain Node launcher, not on the host.
3. Every number the judge acts on is measured over the case it judges, never over another case.
4. Every exit code and message matches the exit-code table in `docs/judge.md`.

Today, from earlier reviews:
- **Docker and a child that hogs memory.** On the Docker route, `OOMKilled` (read in `packages/cli/src/container-check.ts`) is true when any process in the container was killed for memory, even when the check itself exits 0 or 1. So a check can fork a hog and turn its own fail into infra. On the plain Node route the same act is a fail (`FORKED_HOG` in `verdict-model.ts`).
- **Orphans.** The plain Node launcher runs as pid 1 in its container without `--init` and never reaps orphans. A case that forks and exits leaves zombies until the container ends.
- **Measured over the wrong case.** In `packages/cli/src/node-judge.ts:245`, `filled` is measured from the previous case's reading (`last`), not from this case's own start (`before`). A kill in one case can be charged to the next.
- **Host memory kill under a pin.** Under a `node_memory` pin, an exit 137 of pid 1 without the out-of-memory flag can come from the host, outside the judge's limit. Today it fails honest work. The outcome table does not mention this case.
- **verdict-truth leftovers:**
  - `--verdict` on an unwritable path (EACCES, EROFS) exits 78, but `docs/judge.md` says a missing or unreadable file gives 2;
  - a FIFO given as `--verdict` blocks the up-front writability check;
  - `packages/cli/src/rpc-failure.ts` treats HTTP 501 and 505 as temporary, but they are not;
  - setup transactions mark the run as sent before the release is signed, so 76 is reported more often than true.
- **Name clash.** `packages/multisig/src/main.ts:48` exports `EXIT_REFUSED = 1`. The judge's refused code is 78.

## Build

1. **Docker child hog.** Make the Docker route match the plain Node route: a memory kill caused by a process the work started, under the work's own limits, is a fail, written as a fail verdict. A memory kill the work cannot cause stays infra. List every input the decision reads, and show why a check cannot turn its own fail into infra on either route.
2. **Orphans.** Run pid 1 with an init that reaps, or reap in the launcher. Show with a test that a forking case leaves no zombie, and that the case's exit code still reaches the verdict.
3. **Per-case measurement.** Measure `filled`, and every other per-case reading in `node-judge.ts` and the Docker route, from the case's own start. Find every such reading and list it in the report.
4. **Host kill under a pin.** Decide the outcome by the verdict model and give the reason. If the judge cannot tell a host kill from a limit kill, it must not fail the work. Document the case in the outcome table.
5. **Exit codes.** Make the `--verdict` exits match `docs/judge.md`, or fix the table, and give the reason. Make the writability check refuse a FIFO or another non-regular file instead of blocking. Remove 501 and 505 from the temporary codes. Mark a run as sent only once the release transaction itself is sent.
6. **Multisig.** Decide whether the multisig CLI's refused code should be 78 like the judge's, or keep 1 under a name that does not clash. Check every caller of the multisig exit code under `scripts/`, the docs and the tests, and update each one.

## Tests

- **Docker child hog:** a check that forks a memory hog and exits 1 gives a fail verdict on both routes. The Docker test may be gated on Docker, as existing Docker tests are.
- **Orphans:** a case that forks a child and exits leaves no zombie.
- **Per-case:** a test where one case is killed and the next is clean. The clean case is not charged.
- **Exit codes:** one test each for an unwritable `--verdict`, a FIFO `--verdict`, a 501 response, and a setup failure before the release is sent.
- **Mutants:** for items 1 and 3, show that removing the fix fails a test.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Use `performance.now()` for any new wait.
- No program change. No change to a money rule other than what rule 1 requires.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- For each Build item: what changed, where, and the test that covers it.
- The list of per-case readings from item 3.
- The multisig decision, with every caller you updated.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms rules 1 to 4 on every route, and that no judge-caused or host-caused problem became a fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
