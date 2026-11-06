# Job: Every judge exit and label says what happened (verdict-truth)

**Rules:**
1. A caller can tell the four endings of a `judge` run apart by exit code alone:
   - pass, exit 0;
   - fail, exit 1;
   - infra, exit 75;
   - refused, where nothing was judged: a code distinct from 0, 1 and 75.
   This holds in text and JSON output, in `judge --watch` lines and in the MCP tools that run a judgement.
2. A problem the work alone causes is a `fail`, and a problem the judge or the host causes is `infra` or `refused`. Decide by `packages/cli/src/verdict-model.ts` and the outcome table in `docs/maintainers/judge-internals.md`.
3. Every message names the setting that really applies. It never tells the user to change an option that is fixed, derived or refused.

Today:
- A thrown `JudgeRefused` exits 1, the same code as a fail (`packages/cli/src/main.ts:176`). Only `UsageError` gets `EXIT_USAGE` (2).
- Some refusals are caused by the work itself:
  - "`--artifact` is not UTF-8 text" in `packages/cli/src/viper.ts` and `packages/cli/src/host-judge.ts`;
  - non-regular files in the work, in `packages/cli/src/artifact.ts`.
- `judge --watch` prints `outcome: "infra"` on every retry, including refusals that can change, such as "the claim is held by another wallet" or "who the job invites cannot be checked" (`packages/cli/src/judge-watch.ts`).
- The timeout infra message names `--timeout` even when that value is derived from a pinned `judge-run` `timeout` (`packages/cli/src/judge-errors.ts`).
- A `node_memory` pin is only sound where the launcher can read the cgroup v2 `memory.events`. On a cgroup v1 host every count reads null, so a pinned memory kill becomes infra (`OOM_UNREAD`) instead of a fail (`packages/cli/src/node-runner.ts`, `packages/cli/src/verdict-model.ts`).

## Build

1. **A distinct refused exit code.** Choose it, give the reason, and use it for every `JudgeRefused`. Document every exit code in one table in `docs/judge.md` and in the outcome table of `judge-internals.md`. Check every caller that reads `judge`'s exit code: `judge --watch`, the MCP judge tools, `mcp-smoke`, scripts under `scripts/`, the docs and the examples. Update each one to the new code.
2. **Work-caused refusals.** List every `JudgeRefused` and decide for each whether only the work can cause it.
   - Make a work-caused one a `fail` through the one classifier. It must write a fail verdict, and the fail receipt rules apply.
   - Leave a refusal where the judge cannot judge at all, such as a spec problem, a missing key or an announcement that does not open.
   - Give the full list in the report: `path:line`, the old outcome, the new outcome, and why.
3. **Watch labels.** `outcome: "infra"` only on causes that are infra by the verdict model. A refusal that can change gets its own honest label, documented.
4. **Messages.** The timeout message names the pinned `timeout` when a `judge-run` block pins it. Check every other infra and refusal message for the same fault.
5. **The pin on cgroup v1.** Where the launcher cannot read the cgroup memory events, a judgement under a `node_memory` pin must not run as if pinned. Refuse it with an explicit reason before any case runs. `sandbox doctor` reports whether the host can honour a memory pin.

## Tests

- **Exit codes:** one test per ending (pass, fail, infra, refused), through the CLI, asserting the exact exit code. One test that a `--watch` refused line and an infra line carry their right labels.
- **Changed outcomes:** each work-caused refusal you turn into a fail has a test that it now fails, with a fail verdict written.
- **cgroup v1:** a test with the launcher's count unreadable under a pin refuses before any case runs.
- **Mutants:** for the exit-code mapping, show that removing it fails a test.
- The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Use `performance.now()` for any new wait.
- No program change. No change to a money rule other than what rule 2 requires.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- The exit-code table.
- The `JudgeRefused` list with old and new outcomes.
- Every caller you updated.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms rules 1 to 3 on every route, and that no judge-caused problem became a fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
