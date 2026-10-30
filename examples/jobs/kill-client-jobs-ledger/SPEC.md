# Job: Kill the surviving client mutants in the job scan, proofs and Ledger signing

The mutation run at `2947897` leaves 95 mutants alive in `packages/client`, in `src/job-pay.ts`, `src/job-proofs.ts`, `src/job-scan.ts`, `src/job-specs.ts`, `src/ledger-path.ts`, `src/ledger.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `29478977c15576a02bd380ec6cb8e065b3931275`, files under `packages/client`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/job-pay.ts` | 13 | `\|\| -> &&` |
| `src/job-pay.ts` | 16 | `> -> >=` |
| `src/job-pay.ts` | 19 | `- -> +` |
| `src/job-pay.ts` | 21 | `> -> >=` |
| `src/job-pay.ts` | 21 | `\|\| -> &&` |
| `src/job-proofs.ts` | 60 | `\|\| -> &&` |
| `src/job-proofs.ts` | 87 | `> -> >=` |
| `src/job-proofs.ts` | 94 | `> -> >=` |
| `src/job-proofs.ts` | 95 | `== -> !=` |
| `src/job-proofs.ts` | 95 | `true -> false` |
| `src/job-proofs.ts` | 99 | `== -> !=` |
| `src/job-proofs.ts` | 101 | `== -> !=` |
| `src/job-proofs.ts` | 101 | `> -> <` |
| `src/job-proofs.ts` | 101 | `> -> >=` |
| `src/job-proofs.ts` | 101 | `\|\| -> &&` |
| `src/job-proofs.ts` | 113 | `&& -> \|\|` |
| `src/job-proofs.ts` | 121 | `false -> true` |
| `src/job-proofs.ts` | 124 | `<= -> <` |
| `src/job-proofs.ts` | 124 | `<= -> >=` |
| `src/job-scan.ts` | 29 | `\|\| -> &&` |
| `src/job-scan.ts` | 33 | `true -> false` |
| `src/job-scan.ts` | 34 | `true -> false` |
| `src/job-scan.ts` | 37 | `< -> <=` |
| `src/job-scan.ts` | 37 | `< -> >` |
| `src/job-scan.ts` | 38 | `true -> false` |
| `src/job-scan.ts` | 40 | `&& -> \|\|` |
| `src/job-scan.ts` | 40 | `< -> <=` |
| `src/job-scan.ts` | 40 | `< -> >` |
| `src/job-scan.ts` | 40 | `== -> !=` |
| `src/job-scan.ts` | 40 | `true -> false` |
| `src/job-scan.ts` | 52 | `<= -> <` |
| `src/job-scan.ts` | 56 | `&& -> \|\|` |
| `src/job-scan.ts` | 57 | `< -> <=` |
| `src/job-scan.ts` | 61 | `true -> false` |
| `src/job-scan.ts` | 65 | `< -> >` |
| `src/job-scan.ts` | 66 | `true -> false` |
| `src/job-scan.ts` | 69 | `< -> <=` |
| `src/job-scan.ts` | 92 | `- -> +` |
| `src/job-scan.ts` | 107 | `== -> !=` |
| `src/job-specs.ts` | 32 | `false -> true` |
| `src/job-specs.ts` | 94 | `== -> !=` |
| `src/job-specs.ts` | 102 | `!= -> ==` |
| `src/job-specs.ts` | 102 | `&& -> \|\|` |
| `src/job-specs.ts` | 125 | `< -> <=` |
| `src/job-specs.ts` | 155 | `true -> false` |
| `src/job-specs.ts` | 166 | `> -> >=` |
| `src/job-specs.ts` | 179 | `> -> >=` |
| `src/job-specs.ts` | 193 | `== -> !=` |
| `src/job-specs.ts` | 200 | `== -> !=` |
| `src/job-specs.ts` | 250 | `== -> !=` |
| `src/job-specs.ts` | 260 | `true -> false` |
| `src/ledger-path.ts` | 16 | `- -> +` |
| `src/ledger-path.ts` | 42 | `- -> +` |
| `src/ledger-path.ts` | 47 | `& -> |` |
| `src/ledger-path.ts` | 57 | `== -> !=` |
| `src/ledger-path.ts` | 61 | `> -> <` |
| `src/ledger-path.ts` | 61 | `> -> >=` |
| `src/ledger-path.ts` | 74 | `!= -> ==` |
| `src/ledger.ts` | 65 | `== -> !=` |
| `src/ledger.ts` | 65 | `\|\| -> &&` |
| `src/ledger.ts` | 77 | `== -> !=` |
| `src/ledger.ts` | 77 | `\|\| -> &&` |
| `src/ledger.ts` | 104 | `&& -> \|\|` |
| `src/ledger.ts` | 104 | `== -> !=` |
| `src/ledger.ts` | 114 | `&& -> \|\|` |
| `src/ledger.ts` | 114 | `<= -> <` |
| `src/ledger.ts` | 114 | `<= -> >=` |
| `src/ledger.ts` | 114 | `>= -> <=` |
| `src/ledger.ts` | 114 | `>= -> >` |
| `src/ledger.ts` | 114 | `\|\| -> &&` |
| `src/ledger.ts` | 119 | `+ -> -` |
| `src/ledger.ts` | 120 | `* -> /` |
| `src/ledger.ts` | 120 | `+ -> -` |
| `src/ledger.ts` | 122 | `!= -> ==` |
| `src/ledger.ts` | 123 | `&& -> \|\|` |
| `src/ledger.ts` | 123 | `< -> <=` |
| `src/ledger.ts` | 123 | `< -> >` |
| `src/ledger.ts` | 123 | `>= -> <=` |
| `src/ledger.ts` | 123 | `>= -> >` |
| `src/ledger.ts` | 126 | `>= -> <=` |
| `src/ledger.ts` | 126 | `>= -> >` |
| `src/ledger.ts` | 127 | `<= -> <` |
| `src/ledger.ts` | 127 | `<= -> >=` |
| `src/ledger.ts` | 128 | `* -> /` |
| `src/ledger.ts` | 128 | `+ -> -` |
| `src/ledger.ts` | 128 | `== -> !=` |
| `src/ledger.ts` | 129 | `== -> !=` |
| `src/ledger.ts` | 130 | `== -> !=` |
| `src/ledger.ts` | 131 | `- -> +` |
| `src/ledger.ts` | 131 | `== -> !=` |
| `src/ledger.ts` | 131 | `\|\| -> &&` |
| `src/ledger.ts` | 132 | `== -> !=` |
| `src/ledger.ts` | 133 | `* -> /` |
| `src/ledger.ts` | 133 | `+ -> -` |
| `src/ledger.ts` | 143 | `!= -> ==` |

## Build

1. **Tests.** Add tests in `packages/client/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill client survivors in other files at the same time. Put your tests in new files whose names start with `kill-client-jobs-ledger-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the client tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
