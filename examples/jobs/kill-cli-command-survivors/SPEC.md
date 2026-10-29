# Job: Kill the surviving cli mutants in the top-level commands

The mutation run at `7afd3ef` leaves 65 mutants alive in `packages/cli`, in `src/announce-commands.ts`, `src/arg-announce.ts`, `src/arg-values.ts`, `src/claim-commands.ts`, `src/claim-lists.ts`, `src/committee-commands.ts`, `src/crank.ts`, `src/flow-commands.ts`, `src/invites.ts`, `src/job-commands.ts`, `src/main.ts`, `src/monitor-health.ts`, `src/monitor-limits.ts`, `src/npm-registry.ts`, `src/rpc-failure.ts`, `src/sealed-commands.ts`, `src/trust-args.ts`, `src/wallet-commands.ts`, `src/wallet.ts`, `src/wtf8.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `7afd3efa89f8f1dde321cf2c28311628e7adc89e`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/announce-commands.ts` | 68 | `> -> <` |
| `src/announce-commands.ts` | 68 | `> -> >=` |
| `src/announce-commands.ts` | 71 | `== -> !=` |
| `src/announce-commands.ts` | 125 | `== -> !=` |
| `src/announce-commands.ts` | 130 | `false -> true` |
| `src/announce-commands.ts` | 160 | `== -> !=` |
| `src/announce-commands.ts` | 183 | `== -> !=` |
| `src/arg-announce.ts` | 11 | `true -> false` |
| `src/arg-values.ts` | 135 | `&& -> \|\|` |
| `src/arg-values.ts` | 143 | `!= -> ==` |
| `src/arg-values.ts` | 143 | `+ -> -` |
| `src/arg-values.ts` | 143 | `\|\| -> &&` |
| `src/arg-values.ts` | 315 | `> -> >=` |
| `src/claim-commands.ts` | 182 | `&& -> \|\|` |
| `src/claim-commands.ts` | 182 | `> -> >=` |
| `src/claim-commands.ts` | 200 | `== -> !=` |
| `src/claim-commands.ts` | 340 | `== -> !=` |
| `src/claim-lists.ts` | 18 | `== -> !=` |
| `src/claim-lists.ts` | 40 | `> -> >=` |
| `src/claim-lists.ts` | 51 | `true -> false` |
| `src/committee-commands.ts` | 166 | `> -> <` |
| `src/committee-commands.ts` | 166 | `> -> >=` |
| `src/committee-commands.ts` | 175 | `== -> !=` |
| `src/committee-commands.ts` | 183 | `== -> !=` |
| `src/committee-commands.ts` | 183 | `true -> false` |
| `src/committee-commands.ts` | 197 | `\|\| -> &&` |
| `src/crank.ts` | 189 | `* -> /` |
| `src/flow-commands.ts` | 173 | `== -> !=` |
| `src/invites.ts` | 42 | `false -> true` |
| `src/invites.ts` | 44 | `true -> false` |
| `src/job-commands.ts` | 20 | `\|\| -> &&` |
| `src/main.ts` | 128 | `&& -> \|\|` |
| `src/monitor-health.ts` | 28 | `\|\| -> &&` |
| `src/monitor-health.ts` | 33 | `<= -> <` |
| `src/monitor-health.ts` | 35 | `false -> true` |
| `src/monitor-health.ts` | 45 | `>= -> >` |
| `src/monitor-health.ts` | 46 | `< -> <=` |
| `src/monitor-limits.ts` | 22 | `< -> <=` |
| `src/monitor-limits.ts` | 22 | `> -> <` |
| `src/monitor-limits.ts` | 22 | `> -> >=` |
| `src/monitor-limits.ts` | 65 | `&& -> \|\|` |
| `src/npm-registry.ts` | 26 | `== -> !=` |
| `src/npm-registry.ts` | 35 | `> -> >=` |
| `src/rpc-failure.ts` | 18 | `< -> <=` |
| `src/rpc-failure.ts` | 22 | `<= -> <` |
| `src/rpc-failure.ts` | 22 | `>= -> >` |
| `src/sealed-commands.ts` | 68 | `> -> >=` |
| `src/trust-args.ts` | 118 | `/ -> *` |
| `src/trust-args.ts` | 135 | `< -> <=` |
| `src/trust-args.ts` | 135 | `> -> >=` |
| `src/trust-args.ts` | 148 | `> -> >=` |
| `src/wallet-commands.ts` | 29 | `== -> !=` |
| `src/wallet-commands.ts` | 43 | `true -> false` |
| `src/wallet-commands.ts` | 66 | `< -> <=` |
| `src/wallet.ts` | 145 | `< -> <=` |
| `src/wallet.ts` | 208 | `< -> <=` |
| `src/wallet.ts` | 215 | `< -> <=` |
| `src/wallet.ts` | 228 | `< -> <=` |
| `src/wallet.ts` | 231 | `>= -> >` |
| `src/wtf8.ts` | 44 | `- -> +` |
| `src/wtf8.ts` | 49 | `&& -> \|\|` |
| `src/wtf8.ts` | 54 | `< -> <=` |
| `src/wtf8.ts` | 64 | `< -> <=` |
| `src/wtf8.ts` | 66 | `< -> <=` |
| `src/wtf8.ts` | 68 | `< -> <=` |


## Build

1. **Tests.** Add tests in `packages/cli/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill cli survivors in other files at the same time. Put your tests in new files whose names start with `kill-cli-command-survivors-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
