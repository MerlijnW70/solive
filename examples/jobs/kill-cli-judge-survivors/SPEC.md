# Job: Kill the surviving cli mutants in the judge and its sandbox

The mutation run at `7afd3ef` leaves 38 mutants alive in `packages/cli`, in `src/check-output.ts`, `src/container-check.ts`, `src/judge-watch.ts`, `src/judge.ts`, `src/process-reap.ts`, `src/sandbox-doctor.ts`, `src/sandbox.ts`, `src/viper.ts`, `src/worker-secrets.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `7afd3efa89f8f1dde321cf2c28311628e7adc89e`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/check-output.ts` | 23 | `> -> >=` |
| `src/check-output.ts` | 26 | `> -> >=` |
| `src/check-output.ts` | 27 | `true -> false` |
| `src/container-check.ts` | 60 | `== -> !=` |
| `src/judge-watch.ts` | 40 | `< -> <=` |
| `src/judge-watch.ts` | 40 | `> -> <` |
| `src/judge-watch.ts` | 40 | `> -> >=` |
| `src/judge.ts` | 197 | `> -> <` |
| `src/process-reap.ts` | 53 | `false -> true` |
| `src/sandbox-doctor.ts` | 28 | `+ -> -` |
| `src/sandbox-doctor.ts` | 32 | `* -> /` |
| `src/sandbox-doctor.ts` | 52 | `* -> /` |
| `src/sandbox-doctor.ts` | 72 | `!= -> ==` |
| `src/sandbox-doctor.ts` | 87 | `!= -> ==` |
| `src/sandbox-doctor.ts` | 95 | `true -> false` |
| `src/sandbox-doctor.ts` | 99 | `true -> false` |
| `src/sandbox-doctor.ts` | 102 | `true -> false` |
| `src/sandbox-doctor.ts` | 104 | `false -> true` |
| `src/sandbox-doctor.ts` | 105 | `false -> true` |
| `src/sandbox-doctor.ts` | 115 | `false -> true` |
| `src/sandbox-doctor.ts` | 118 | `== -> !=` |
| `src/sandbox-doctor.ts` | 119 | `false -> true` |
| `src/sandbox-doctor.ts` | 123 | `&& -> \|\|` |
| `src/sandbox-doctor.ts` | 123 | `== -> !=` |
| `src/sandbox-doctor.ts` | 130 | `&& -> \|\|` |
| `src/sandbox-doctor.ts` | 130 | `== -> !=` |
| `src/sandbox-doctor.ts` | 132 | `&& -> \|\|` |
| `src/sandbox-doctor.ts` | 135 | `true -> false` |
| `src/sandbox-doctor.ts` | 136 | `true -> false` |
| `src/sandbox.ts` | 67 | `== -> !=` |
| `src/sandbox.ts` | 67 | `true -> false` |
| `src/sandbox.ts` | 120 | `\|\| -> &&` |
| `src/sandbox.ts` | 141 | `false -> true` |
| `src/sandbox.ts` | 144 | `true -> false` |
| `src/viper.ts` | 247 | `> -> >=` |
| `src/viper.ts` | 248 | `true -> false` |
| `src/worker-secrets.ts` | 63 | `\|\| -> &&` |
| `src/worker-secrets.ts` | 80 | `true -> false` |


## Build

1. **Tests.** Add tests in `packages/cli/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill cli survivors in other files at the same time. Put your tests in new files whose names start with `kill-cli-judge-survivors-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- A mutant in `src/process-reap.ts` can kill every process of your user, including your shell. Run any mutated suite inside `unshare --user --map-current-user --pid --fork --mount-proc setsid --wait`.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
