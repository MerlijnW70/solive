# Job: Kill the cli mutants of 2026-11-01, second part

The cli mutation run at `cb5a02e` left these mutants alive in `packages/cli`; part one already covered the rest. Each changes one operator or literal on a line, and every test still passed. Write the tests that catch them.

## Survivors

Lines are at `cb5a02ea8d68fcbf4d3410c7e605f609e70fc1eb`, files under `packages/cli`. Some files changed on `main` since then (for example `src/faucet.ts`): find each line's current place by its text; if the line no longer exists or no longer holds that operator, say so in the report and skip it. `a→b` means operator `a` became `b`; for `==` the mutant is `===` becoming `!==`. `true→false` and `false→true` flip a boolean literal. Where a line holds the operator more than once, kill the mutant at every position.

| File:line | Mutant |
|---|---|
| `src/agent/wallet/worker.ts:161` | `!=→==` |
| `src/agent/wallet/worker.ts:161` | `<→<=` |
| `src/agent/wallet/worker.ts:169` | `false→true` |
| `src/agent/wallet/worker.ts:183` | `false→true` |
| `src/faucet.ts:115` | `>=→>` |
| `src/faucet.ts:124` | `&&→\|\|` |
| `src/faucet.ts:141` | `true→false` |
| `src/job-pages.ts:109` | `-→+` |
| `src/job-pages.ts:109` | `>→>=` |
| `src/job-pages.ts:37` | `>→>=` |
| `src/job-pages.ts:40` | `>→>=` |
| `src/job-pages.ts:42` | `<→<=` |
| `src/job-pages.ts:42` | `<→>` |
| `src/judge-watch.ts:40` | `>→<` |
| `src/judge-watch.ts:40` | `>→>=` |
| `src/main.ts:242` | `==→!=` |
| `src/main.ts:242` | `true→false` |
| `src/monitor-health.ts:28` | `\|\|→&&` |
| `src/monitor-health.ts:33` | `<=→<` |
| `src/monitor-health.ts:45` | `>=→>` |
| `src/monitor-health.ts:46` | `<→<=` |
| `src/monitor-limits.ts:22` | `<→<=` |
| `src/monitor-limits.ts:22` | `>→<` |
| `src/monitor-limits.ts:22` | `>→>=` |
| `src/render.ts:33` | `\|\|→&&` |
| `src/resaved.ts:17` | `>=→>` |
| `src/sandbox-doctor.ts:117` | `false→true` |
| `src/viper.ts:247` | `>→>=` |
| `src/wtf8.ts:44` | `-→+` |
| `src/wtf8.ts:54` | `<→<=` |

## Build

1. **Tests.** Add or tighten tests under `packages/cli/test` so each mutant makes at least one test fail. Assert exact values and boundaries.
2. **Equivalent mutants.** If a row cannot change behaviour, say so in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only test files, unless a real bug needs a source fix. Public exports, tool names and texts stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand and the cli tests fail, or the report names it as equivalent or gone with a reason the judge confirms.
3. The report lists every row as killed, equivalent, gone or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
