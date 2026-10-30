# Job: Kill the surviving client mutants in trust, reputation and work records

The mutation run at `2947897` leaves 79 mutants alive in `packages/client`, in `src/svm-errors.ts`, `src/svm.ts`, `src/testing.ts`, `src/transaction-keys.ts`, `src/trust.ts`, `src/unopened.ts`, `src/wallet-reads.ts`, `src/work-feedback.ts`, `src/work-records.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `29478977c15576a02bd380ec6cb8e065b3931275`, files under `packages/client`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/svm-errors.ts` | 58 | `\|\| -> &&` |
| `src/svm.ts` | 57 | `true -> false` |
| `src/svm.ts` | 60 | `+ -> -` |
| `src/svm.ts` | 60 | `>= -> >` |
| `src/svm.ts` | 85 | `< -> <=` |
| `src/svm.ts` | 85 | `\|\| -> &&` |
| `src/svm.ts` | 93 | `< -> <=` |
| `src/svm.ts` | 159 | `== -> !=` |
| `src/testing.ts` | 144 | `== -> !=` |
| `src/testing.ts` | 145 | `== -> !=` |
| `src/testing.ts` | 146 | `== -> !=` |
| `src/testing.ts` | 147 | `== -> !=` |
| `src/testing.ts` | 148 | `== -> !=` |
| `src/testing.ts` | 163 | `> -> >=` |
| `src/testing.ts` | 208 | `> -> >=` |
| `src/testing.ts` | 212 | `> -> >=` |
| `src/testing.ts` | 220 | `+ -> -` |
| `src/testing.ts` | 220 | `< -> <=` |
| `src/transaction-keys.ts` | 44 | `+ -> -` |
| `src/transaction-keys.ts` | 47 | `< -> <=` |
| `src/transaction-keys.ts` | 57 | `> -> >=` |
| `src/transaction-keys.ts` | 70 | `!= -> ==` |
| `src/transaction-keys.ts` | 76 | `- -> +` |
| `src/transaction-keys.ts` | 102 | `> -> >=` |
| `src/trust.ts` | 74 | `false -> true` |
| `src/trust.ts` | 80 | `+ -> -` |
| `src/trust.ts` | 81 | `+ -> -` |
| `src/trust.ts` | 107 | `> -> >=` |
| `src/trust.ts` | 126 | `>= -> >` |
| `src/trust.ts` | 126 | `\|\| -> &&` |
| `src/trust.ts` | 130 | `* -> /` |
| `src/trust.ts` | 135 | `/ -> *` |
| `src/trust.ts` | 137 | `- -> +` |
| `src/trust.ts` | 161 | `<= -> <` |
| `src/trust.ts` | 170 | `< -> <=` |
| `src/trust.ts` | 193 | `+= -> -=` |
| `src/trust.ts` | 203 | `> -> >=` |
| `src/trust.ts` | 226 | `> -> >=` |
| `src/unopened.ts` | 62 | `== -> !=` |
| `src/unopened.ts` | 63 | `!= -> ==` |
| `src/unopened.ts` | 63 | `== -> !=` |
| `src/unopened.ts` | 63 | `true -> false` |
| `src/unopened.ts` | 68 | `false -> true` |
| `src/unopened.ts` | 72 | `> -> <` |
| `src/unopened.ts` | 72 | `> -> >=` |
| `src/unopened.ts` | 73 | `<= -> <` |
| `src/unopened.ts` | 73 | `<= -> >=` |
| `src/unopened.ts` | 77 | `<= -> <` |
| `src/unopened.ts` | 77 | `<= -> >=` |
| `src/unopened.ts` | 77 | `== -> !=` |
| `src/unopened.ts` | 83 | `< -> <=` |
| `src/unopened.ts` | 83 | `< -> >` |
| `src/unopened.ts` | 83 | `> -> <` |
| `src/unopened.ts` | 83 | `> -> >=` |
| `src/unopened.ts` | 84 | `> -> <` |
| `src/unopened.ts` | 84 | `> -> >=` |
| `src/unopened.ts` | 102 | `<= -> <` |
| `src/unopened.ts` | 102 | `<= -> >=` |
| `src/unopened.ts` | 111 | `== -> !=` |
| `src/unopened.ts` | 121 | `== -> !=` |
| `src/unopened.ts` | 139 | `!= -> ==` |
| `src/unopened.ts` | 140 | `!= -> ==` |
| `src/unopened.ts` | 140 | `true -> false` |
| `src/wallet-reads.ts` | 15 | `< -> <=` |
| `src/wallet-reads.ts` | 20 | `< -> <=` |
| `src/work-feedback.ts` | 6 | `< -> <=` |
| `src/work-feedback.ts` | 6 | `< -> >` |
| `src/work-feedback.ts` | 6 | `> -> <` |
| `src/work-feedback.ts` | 6 | `> -> >=` |
| `src/work-records.ts` | 72 | `< -> <=` |
| `src/work-records.ts` | 72 | `< -> >` |
| `src/work-records.ts` | 72 | `> -> <` |
| `src/work-records.ts` | 72 | `> -> >=` |
| `src/work-records.ts` | 101 | `&& -> \|\|` |
| `src/work-records.ts` | 101 | `== -> !=` |
| `src/work-records.ts` | 156 | `&& -> \|\|` |
| `src/work-records.ts` | 208 | `false -> true` |
| `src/work-records.ts` | 236 | `&& -> \|\|` |
| `src/work-records.ts` | 243 | `== -> !=` |

## Build

1. **Tests.** Add tests in `packages/client/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill client survivors in other files at the same time. Put your tests in new files whose names start with `kill-client-trust-work-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the client tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
