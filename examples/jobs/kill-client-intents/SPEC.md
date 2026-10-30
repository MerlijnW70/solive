# Job: Kill the surviving client mutants in the intent and claim calls

The mutation run at `2947897` leaves 53 mutants alive in `packages/client`, in `src/client-claims.ts`, `src/client-create.ts`, `src/client-intents.ts`, `src/client-reads.ts`, `src/client-settle.ts`, `src/client-split.ts`, `src/client-watch.ts`, `src/confirm-release.ts`, `src/confirmation.ts`, `src/errors.ts`, `src/first-opening.ts`, `src/funding.ts`, `src/intent-notifications.ts`, `src/intent-ref.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `29478977c15576a02bd380ec6cb8e065b3931275`, files under `packages/client`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/client-claims.ts` | 61 | `\|\| -> &&` |
| `src/client-claims.ts` | 73 | `== -> !=` |
| `src/client-claims.ts` | 107 | `< -> <=` |
| `src/client-claims.ts` | 160 | `< -> >` |
| `src/client-create.ts` | 68 | `- -> +` |
| `src/client-create.ts` | 68 | `<= -> <` |
| `src/client-create.ts` | 68 | `<= -> >=` |
| `src/client-create.ts` | 72 | `== -> !=` |
| `src/client-create.ts` | 74 | `== -> !=` |
| `src/client-create.ts` | 93 | `< -> <=` |
| `src/client-create.ts` | 122 | `> -> >=` |
| `src/client-create.ts` | 167 | `> -> >=` |
| `src/client-create.ts` | 168 | `> -> >=` |
| `src/client-intents.ts` | 57 | `> -> >=` |
| `src/client-intents.ts` | 58 | `> -> >=` |
| `src/client-intents.ts` | 59 | `> -> <` |
| `src/client-intents.ts` | 59 | `> -> >=` |
| `src/client-reads.ts` | 43 | `> -> >=` |
| `src/client-reads.ts` | 49 | `== -> !=` |
| `src/client-reads.ts` | 63 | `!= -> ==` |
| `src/client-settle.ts` | 52 | `!= -> ==` |
| `src/client-settle.ts` | 88 | `- -> +` |
| `src/client-split.ts` | 37 | `false -> true` |
| `src/client-split.ts` | 42 | `false -> true` |
| `src/client-watch.ts` | 66 | `> -> >=` |
| `src/client-watch.ts` | 73 | `<= -> <` |
| `src/client-watch.ts` | 112 | `> -> >=` |
| `src/client-watch.ts` | 127 | `true -> false` |
| `src/client-watch.ts` | 135 | `&& -> \|\|` |
| `src/client-watch.ts` | 135 | `* -> /` |
| `src/client-watch.ts` | 135 | `- -> +` |
| `src/client-watch.ts` | 135 | `>= -> >` |
| `src/confirm-release.ts` | 109 | `< -> <=` |
| `src/confirmation.ts` | 56 | `== -> !=` |
| `src/confirmation.ts` | 179 | `true -> false` |
| `src/confirmation.ts` | 181 | `== -> !=` |
| `src/confirmation.ts` | 188 | `> -> >=` |
| `src/errors.ts` | 31 | `> -> >=` |
| `src/errors.ts` | 56 | `+ -> -` |
| `src/errors.ts` | 60 | `!= -> ==` |
| `src/first-opening.ts` | 99 | `>> -> <<` |
| `src/first-opening.ts` | 100 | `true -> false` |
| `src/first-opening.ts` | 117 | `>> -> <<` |
| `src/funding.ts` | 30 | `- -> +` |
| `src/funding.ts` | 54 | `< -> <=` |
| `src/funding.ts` | 58 | `< -> >` |
| `src/funding.ts` | 59 | `false -> true` |
| `src/funding.ts` | 63 | `false -> true` |
| `src/intent-notifications.ts` | 66 | `true -> false` |
| `src/intent-notifications.ts` | 102 | `> -> <` |
| `src/intent-notifications.ts` | 102 | `> -> >=` |
| `src/intent-notifications.ts` | 116 | `- -> +` |
| `src/intent-ref.ts` | 19 | `\|\| -> &&` |

## Build

1. **Tests.** Add tests in `packages/client/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill client survivors in other files at the same time. Put your tests in new files whose names start with `kill-client-intents-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the client tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
