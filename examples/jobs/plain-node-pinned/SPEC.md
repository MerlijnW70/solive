# Job: Plain Node memory can be pinned, and a case cannot reach the launcher on any host (plain-node-pinned)

**Rules:**
1. A spec can pin the memory that plain Node cases run under (`judge --sandbox viper --plain-node`). Under a pinned memory, a case killed for memory is a `fail`. Without a pin, it stays `infra`, as today. The judge runs plain Node with exactly the pinned memory and refuses a `--sandbox-memory` that differs from it, as it does for a `judge-run` block.
2. A case cannot read or write the launcher's memory, trace it, or send it any signal, on any host, whatever the host's Yama `ptrace_scope` is.

Today plain Node memory is always the judge's choice (`run-plan.ts` refuses a `judge-run` block for any sandbox but docker), so a delivery can turn its own plain Node fail into infra by causing a real memory kill. Ways to cause it: allocating, forking a hog, or setting `oom_score_adj` and spawning a hog. A pin closes that route for specs that want it.

The launcher (pid 1) and every case run as the same uid (`packages/cli/src/node-judge.ts`, `packages/cli/src/node-runner.ts`). On WSL, Yama `ptrace_scope` is 1, and a case's open of `/proc/1/mem` fails with EACCES. On a host with scope 0, or with no Yama, a same-uid case could likely open it and run code in the launcher. A same-uid case can also send the launcher signals today, for example SIGSTOP.

## Build

1. **The pin.**
   - Add an optional field to the `judge-cases` block that pins plain Node memory, in the same size format as `--sandbox-memory`.
   - Validate it wherever `judge-cases` is parsed, refusing an invalid value with a clear reason.
   - Pass it to the plain Node run as the pinned limit; `caseOutcome` in `packages/cli/src/verdict-model.ts` already makes a memory kill under pinned memory a fail.
   - The field changes nothing for a judgement without `--plain-node`.
2. **Separate the launcher from the cases.**
   - Run the cases under a uid that differs from the launcher's, so rule 2 holds by kernel permission and not by a host setting.
   - Keep every other container restriction (`no-new-privileges`, read-only root, network none, pids limit). Grant the launcher only the capabilities it needs to start a case under another uid, and make sure a case can never hold them.
   - If this cannot be done soundly, say why, with evidence, and instead refuse plain Node with an explicit `infra` reason on hosts where `ptrace_scope` is below 1 or Yama is missing. In that case also report the scope in `sandbox doctor`.
3. **Docs.** Update the plain Node paragraphs and the outcome table in `docs/maintainers/judge-internals.md`, the `judge-cases` field reference wherever it is documented, and the docs-table test.

## Tests

- **Pinned memory:** a case killed for memory is a fail (exit 1). The same spec without the pin gives infra.
- **Refusals:** a `--sandbox-memory` that differs from the pin is refused, and an invalid pin value is refused.
- **Separation, live:**
  - the case's uid differs from the launcher's;
  - `process.kill(1, sig)` fails with EPERM for SIGSTOP, SIGKILL and SIGUSR1;
  - opening `/proc/1/mem` fails;
  - every existing plain Node test still passes.
- **Regression:** the earlier SIGUSR1 debugger attack test still passes.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Self-check before delivering

- Can a case gain the launcher's uid or capabilities, through `/proc/1/*`, inherited file descriptors, the launcher's spawn options, or environment?
- Can the case still write into the channel the judge reads?
- Does the pin let a hirer turn an honest delivery's judge-caused stop into a fail? (A pin is the hirer's own choice, visible in the spec before a worker accepts it, so a fail under it is intended. Confirm that the pin is shown wherever the spec's limits are shown to a worker.)

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Use `performance.now()` for any new wait.
- No program change.
- Do not touch `packages/cli/src/judge-watch.ts`, `packages/cli/src/draw.ts` or `docs/mcp.md`. Another job owns them.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- The design of the separation, with evidence.
- The changes.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms rule 2 by attack.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
