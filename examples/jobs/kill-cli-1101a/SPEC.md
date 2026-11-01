# Job: Kill the cli mutants of 2026-11-01, first part

The cli mutation run at `cb5a02e` leaves these mutants alive in `packages/cli`. Each changes one operator or literal on a line, and every test still passes. Most sit in the local worker's leftover return (`src/agent/wallet/worker-return.ts`), which decides when a worker key may be deleted, so they matter. Write the tests that catch them.

## Survivors

Lines are at `cb5a02ea8d68fcbf4d3410c7e605f609e70fc1eb`, files under `packages/cli`. `a→b` means operator `a` on that line became `b`; for `==` the mutant is `===` becoming `!==`. `true→false` and `false→true` flip a boolean literal. Where a line holds the operator more than once, kill the mutant at every position.

| File:line | Mutant |
|---|---|
| `src/agent/mandate-state.ts:147` | `<→<=` |
| `src/agent/mandate-state.ts:147` | `>→>=` |
| `src/agent/wallet/delivery.ts:262` | `<→<=` |
| `src/agent/wallet/history-work.ts:112` | `&&→\|\|` |
| `src/agent/wallet/history-work.ts:264` | `==→!=` |
| `src/agent/wallet/history-work.ts:80` | `<→<=` |
| `src/agent/wallet/history.ts:43` | `false→true` |
| `src/agent/wallet/judge-work.ts:139` | `&&→\|\|` |
| `src/agent/wallet/judge-work.ts:139` | `==→!=` |
| `src/agent/wallet/judge-work.ts:152` | `true→false` |
| `src/agent/wallet/judge-work.ts:205` | `>→>=` |
| `src/agent/wallet/judge-work.ts:206` | `&&→\|\|` |
| `src/agent/wallet/judge-work.ts:207` | `&&→\|\|` |
| `src/agent/wallet/receipt.ts:93` | `&&→\|\|` |
| `src/agent/wallet/seal.ts:58` | `>→>=` |
| `src/agent/wallet/worker-return.ts:101` | `<→<=` |
| `src/agent/wallet/worker-return.ts:137` | `==→!=` |
| `src/agent/wallet/worker-return.ts:152` | `+=→-=` |
| `src/agent/wallet/worker-return.ts:164` | `>→>=` |
| `src/agent/wallet/worker-return.ts:175` | `+→-` |
| `src/agent/wallet/worker-return.ts:207` | `+→-` |
| `src/agent/wallet/worker-return.ts:209` | `+→-` |
| `src/agent/wallet/worker-return.ts:210` | `+→-` |
| `src/agent/wallet/worker-return.ts:213` | `-→+` |
| `src/agent/wallet/worker-return.ts:213` | `>→<` |
| `src/agent/wallet/worker-return.ts:226` | `==→!=` |
| `src/agent/wallet/worker-return.ts:231` | `>→<` |
| `src/agent/wallet/worker-return.ts:238` | `>→>=` |
| `src/agent/wallet/worker-return.ts:241` | `==→!=` |
| `src/agent/wallet/worker-return.ts:241` | `false→true` |
| `src/agent/wallet/worker-return.ts:241` | `true→false` |
| `src/agent/wallet/worker-return.ts:243` | `>→<` |
| `src/agent/wallet/worker-return.ts:243` | `>→>=` |
| `src/agent/wallet/worker-return.ts:250` | `>→>=` |
| `src/agent/wallet/worker-return.ts:256` | `==→!=` |
| `src/agent/wallet/worker-return.ts:256` | `true→false` |
| `src/agent/wallet/worker-return.ts:77` | `>→>=` |
| `src/agent/wallet/worker-return.ts:89` | `&&→\|\|` |
| `src/agent/wallet/worker-return.ts:89` | `+→-` |
| `src/agent/wallet/worker-return.ts:89` | `>=→>` |
| `src/agent/wallet/worker.ts:154` | `<=→<` |
| `src/agent/wallet/worker.ts:160` | `-→+` |
| `src/bin.ts:12` | `<→<=` |
| `src/bin.ts:9` | `<→<=` |
| `src/check-output.ts:23` | `>→>=` |
| `src/commands.ts:74` | `true→false` |
| `src/container-check.ts:122` | `\|\|→&&` |

## Build

1. **Tests.** Add or tighten tests under `packages/cli/test` so each mutant makes at least one test fail. Assert exact values and boundaries: amounts returned, what is kept and why, when a key file is deleted and when it is not, the edge value accepted and one past it refused.
2. **Equivalent mutants.** If a row cannot change behaviour, say so in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only test files, unless a real bug needs a source fix. Public exports, tool names and texts stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand and the cli tests fail, or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
