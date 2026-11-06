# Job: Plain Node cases follow the verdict model when they run out of memory (plain-node-oom)

**Rules:**
1. A plain Node case (`judge --sandbox viper --plain-node`) that is killed for memory under a limit the judge chose is `infra`, never a fail. Under a limit the spec pins, it is `fail`. This is the same rule the Docker route follows (`packages/cli/src/verdict-model.ts`, `docs/maintainers/judge-internals.md`).
2. The work cannot make a memory kill look like anything else, or anything else look like a memory kill. A case that kills itself, exits, aborts or crashes for any other reason stays a fail as today.
3. Only a signal the work cannot forge or hide decides that a case was killed for memory, such as the container cgroup's `oom_kill` count read from the host. The case's own exit code, signal or output cannot decide it.

Today each case runs as a fresh child process of the runner inside one container (`packages/cli/src/node-runner.ts`, `packages/cli/src/node-judge.ts`). The container's memory comes from `--sandbox-memory`, which the judge chooses. A case killed for memory writes no framed answer, so `caseVerdict` (`packages/cli/src/node-judge.ts:96`) calls it `crashed`, and the judgement fails.

## Build

1. **Reproduce, and report what you observe.** Write a case that allocates until it is stopped, and run it under plain Node with a small `--sandbox-memory`. Report the case's exit code and signal as the runner sees them, the container's `memory.events` before and after, and whether V8's own heap limit or the kernel stops it first. Repeat for a case that SIGKILLs itself and for one that calls `process.abort()`.
2. **Decide which limits the judge chose and which the spec pins.** Today no spec field pins plain Node memory: check this, and say whether a `judge-run` block or the `judge-cases` `heap` applies to plain Node. Do not add a new spec field in this job. If one is needed, propose it in the report.
3. **Attribute memory kills per case** with a trusted signal. If the kill hits the runner itself or the whole container, the stop must be infra too. Feed the outcome into the one classifier in `verdict-model.ts`; do not build a second classifier.
4. **Docs.** Update the outcome table and the plain Node paragraph in `docs/maintainers/judge-internals.md`, plus its docs-table test.

## Tests

- A case killed for memory under judge-chosen memory gives `infra` (exit 75). Cover both stoppers: the kernel, and V8's heap limit if it can stop a case first.
- A case that SIGKILLs itself, one that aborts and one that exits non-zero each stay a fail.
- A classifier row for each, in the existing classifier tests.
- A live Docker test, skipped when Docker is missing, as the other live judge tests do.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Self-check before delivering

- Can a case raise the `oom_kill` count without the judge's limit being the cause, for example by forking a process that is killed instead? If so, is the result still sound?
- Can a case hide a real memory kill?
- Does the result differ between Node 22.12.0 and the newest Node? Run the plain Node tests on both.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- What step 1 observed, with evidence.
- The changes.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that rule 2 cannot be gamed by the work.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
