# Job: The verdict model holds on the Node floor and on hosts without the OOM flag (verdict-node-floor)

**Rules:**
1. Every judge outcome is the same on every supported Node version, from the floor that the `node-floor` CI job runs (`node-version: 22.12.0` in `.github/workflows/ci.yml`) to the newest.
2. An out-of-memory kill under a memory limit that the judge chose is `infra`, and under a limit that the spec pins it is `fail`. This holds whether or not the Docker daemon sets `State.OOMKilled`. A check that kills itself is `fail`.

GitHub CI run 42207929890 on commit `c3a3d254` failed in `node-floor` with 4 tests:

- On Node 22.12.0, these 3 tests give infra (exit 75) where Node 24 gives a `no-module` fail (exit 1). Each covers a module whose top-level code can never finish loading in the host engine:
  - `packages/cli/test/host-judge-attacks.test.ts` "cannot do it with top-level code that can never finish loading";
  - `packages/cli/test/judge-work-tool.test.ts` "returns infra, never pass or fail, when an engine crashes…", at line 188;
  - `packages/cli/test/verdict-routes.test.ts` "fails a delivery whose top-level code can never finish loading in the host engine", at line 117.
- `packages/cli/test/sandbox-doctor.test.ts` at line 42, live on the GitHub runner's Docker: the check "a memory bomb is killed at the memory limit and reported as out of memory" returned `ok: false`. The doctor's memory probe now needs `State.OOMKilled`, and that runner's Docker does not appear to set it.

## Build

1. **Reproduce both** before changing anything:
   - Run the three host-engine tests under Node 22.12.0. Download that exact Node build into your own directory in WSL, and do not change the system Node.
   - Find out what the GitHub runner's Docker reports for a container killed at its memory limit: `State.OOMKilled`, `ExitCode`, the cgroup `memory.events` `oom_kill` count, and any other signal. Use the CI logs, Docker's documentation and source, and a local reproduction with cgroup v2 settings close to `ubuntu-24.04`'s.

   Report what differs, with evidence.
2. **Fix the host-engine route** in the runner (`packages/cli/src/host-judge.ts`, `HOST_RUNNER`) so the never-settling top-level case is attributed to the work on every supported Node. Do not change the classifier to special-case a Node version. If Node 22.12 cannot tell the case apart at all, say so with evidence and propose the closest sound rule.
3. **Fix OOM attribution** so rule 2 holds on daemons that do not set `OOMKilled`. Use a signal the judge can trust, such as the container's cgroup `oom_kill` count read before removal, or Docker's event stream. Never use the container's own exit code, which the work controls. Apply this in the one classifier (`packages/cli/src/verdict-model.ts`) and in `packages/cli/src/container-check.ts`, and update the doctor's memory probe to the same rule. If no trustworthy signal exists on such a host, the doctor must say so plainly, and the judge must treat an exit 137 under a judge-chosen limit, with no trustworthy signal, as infra rather than fail. Explain why in the report.
4. **Docs.** Update the outcome table in `docs/maintainers/judge-internals.md` and its docs-table test.

## Tests

- The three host-engine tests pass on Node 22.12.0 and on the version the main CI uses. Add a CI-independent way to run them on the floor locally, and report its output.
- Classifier rows for OOM with and without `OOMKilled`, with and without the trusted signal, under judge-chosen and pinned limits, and for a self-kill with 137.
- The live doctor test passes on a daemon that does not set `OOMKilled`, or its expectation is changed with a stated reason that rule 2 supports.
- The existing suites of every package you change still pass. Do not weaken any assertion.

## Self-check before delivering

- Can the work fake the trusted OOM signal, or hide a real one?
- Can a host problem now look like a fail?
- Does any other judge route behave differently on Node 22.12, for example viper, plain Node, draws or `judge_work`? Run the judge test files on the floor and report the result.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- Both reproductions with evidence.
- The changes.
- The floor test output.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The three host-engine tests pass on Node 22.12.0.
3. A review confirms rule 2 cannot be gamed by the work.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
