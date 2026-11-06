# Job: One verdict model for every judge route (judge-verdict-model)

**Rules:**
1. Every judgement ends in exactly one of three outcomes: `pass`, `fail` or `infra`.
2. `fail` only when the work itself is shown to fall short of the spec. `infra` whenever the cause cannot be attributed to the work. `pass` only when every check ran and passed.
3. One classifier decides the outcome for every route: `judge` with `--sandbox docker`, `--sandbox none`, `--sandbox viper` with and without `--plain-node`, `judge --watch`, committee judging, and the MCP tool `solive_wallet_judge_work`. No route classifies on its own.

Today the routes disagree:
- A Docker check that itself exits 125 or 137 becomes infra, exit 75 (`packages/cli/src/container-check.ts:121`), so the work can turn its own fail into a retry.
- A viper or host judgement that reaches the judgement's overall deadline becomes a `stopped` fail, exit 1 (`packages/cli/src/viper.ts:374`, `packages/cli/src/host-judge.ts:137`). The same deadline under Docker is infra (`packages/cli/src/judge.ts:402`). `docs/maintainers/judge-internals.md:43` says reaching the deadline says nothing about the work.
- An engine process that crashes or answers unreadably is a `crashed` fail (`packages/cli/src/host-judge.ts:138`, `packages/cli/src/viper.ts:377`), although the work is not shown to be at fault.

These are examples only. Find every place that turns a run into an outcome.

## Build

1. **Find every outcome site.** Search `packages/cli/src` (and any other package) for every place that turns a check, an engine run or an error into pass, fail, infra, retry, skipped or refused: at least `judge.ts`, `judge-watch.ts`, `container-check.ts`, `check-process.ts`, `viper.ts`, `host-judge.ts`, `judge-errors.ts`, `main.ts` and `agent/wallet/judge-work.ts`. List each site in the report, with its outcome today and after the patch.
2. **One classifier.** Add one module that maps a run's facts to an outcome and a reason. Every site from item 1 uses it. Attribution:
   - **Docker:** read the container's own state with `docker container inspect` before removal. If it started and its `State.Error` is empty, its own `State.ExitCode` decides: 0 is pass, every other code is fail, 125 and 137 included. The exceptions are infra: `State.OOMKilled` is true, the judge itself killed it for its deadline, inspect fails, the container never started, or `State.Error` is set.
   - **`--sandbox none`:** the check's exit code decides. A kill by the judge for its deadline is infra.
   - **Overall deadline:** the judgement's `--timeout`, or the MCP tool's fixed budget, reached in any engine is infra, never fail.
   - **Per-case limits** stay a `stopped` case fail: the host engine's per-call limit, and the `steps` and `heap` limits that the spec's `judge-cases` block sets for viper. They are fixed or pinned by the spec, and apply the same way to every case.
   - **Per-case `engine` verdicts:** find out what produces them and attribute each cause by rule 2. Put each cause in the report.
   - **Engine process failure:** viper or the host engine ends non-zero, writes no readable verdict, or answers the wrong number of cases. That is infra, never pass or fail.
3. **Same exits everywhere.** pass exits 0 and may be signed; fail exits 1 and is never signed; infra exits 75, signs nothing and writes no verdict. `judge --watch` keeps today's behaviour for infra: retry, then skip after its existing limit. The MCP tool returns a distinct non-pass, non-fail result for infra, with its reason, and never tells the caller to attest.
4. **Docs follow the classifier.** Update `docs/maintainers/judge-internals.md`, `docs/judge.md` and every tool description or next-hint that states an outcome. Add a test that fails when the docs' outcome table and the classifier disagree.

## Tests

- **A table test of the classifier** covering every attribution row above, including Docker 0, 1, 125 and 137 with and without `OOMKilled`, `State.Error`, never started, inspect failing, deadline kill, and interrupt.
- **One end-to-end test per route** from rule 3, for at least one fail, one infra and one pass, through the real command or tool. Docker tests use the existing judge kit. If Docker is unavailable, the test must fail loudly, not skip silently, unless the existing suite already gates on it; report the skip count.
- **Interrupts and signing:** SIGINT and SIGTERM keep exits 130 and 143. No infra or fail outcome can reach a signature: test it on the signing path, not only the classifier.
- **The existing suites** of every package you change still pass. Do not weaken any assertion; where an assertion encodes the old, wrong outcome, change it and list it in the report with the reason.

## Self-check before delivering

A reviewer will attack your patch in these ways. Check each one yourself and report what you found:
- Find another route to the same hole: another entry point (CLI vs MCP, committee vs single judge, `--watch`, `--plain-node`), another sandbox, or another engine.
- Can the work make itself look like infra, or make a host problem look like a fail? Try: exit 125 or 137 from inside the container, `kill -9` of itself, filling memory below the limit, writing to stderr like Docker, crashing an engine on purpose, and hanging until the deadline.
- Can any path sign without every check passing?
- Boundary values: a deadline of 0, a timeout reached during inspect, a container that exits during the judge's kill.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Do not change what a pass prints or signs.
- Rebase onto the latest `origin/main` right before delivering, rerun the tests, and name the base commit in the report.
- Never write to the shared git config.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Report

- The outcome-site list from item 1.
- Each changed assertion and why.
- The self-check findings.
- **Same defect elsewhere:** `path:line — why`, including outside the files you changed.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that every site from item 1 uses the classifier, and that the self-check attacks fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
