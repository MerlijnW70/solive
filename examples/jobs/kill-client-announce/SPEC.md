# Job: Kill the surviving client mutants in the announcement and account reads

The mutation run at `2947897` leaves 68 mutants alive in `packages/client`, in `src/accounts.ts`, `src/address-ranges.ts`, `src/announce-errors.ts`, `src/announce-keys.ts`, `src/announce.ts`, `src/announcement-reads.ts`, `src/announcement-sends.ts`, `src/budget.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `29478977c15576a02bd380ec6cb8e065b3931275`, files under `packages/client`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/accounts.ts` | 55 | `\|\| -> &&` |
| `src/accounts.ts` | 94 | `\|\| -> &&` |
| `src/accounts.ts` | 137 | `+ -> -` |
| `src/accounts.ts` | 137 | `<= -> <` |
| `src/accounts.ts` | 137 | `true -> false` |
| `src/accounts.ts` | 139 | `true -> false` |
| `src/address-ranges.ts` | 26 | `\|\| -> &&` |
| `src/address-ranges.ts` | 35 | `true -> false` |
| `src/address-ranges.ts` | 67 | `&& -> \|\|` |
| `src/address-ranges.ts` | 70 | `& -> |` |
| `src/address-ranges.ts` | 78 | `&& -> \|\|` |
| `src/address-ranges.ts` | 78 | `== -> !=` |
| `src/address-ranges.ts` | 81 | `&& -> \|\|` |
| `src/address-ranges.ts` | 81 | `== -> !=` |
| `src/address-ranges.ts` | 87 | `&& -> \|\|` |
| `src/address-ranges.ts` | 87 | `== -> !=` |
| `src/address-ranges.ts` | 88 | `\|\| -> &&` |
| `src/address-ranges.ts` | 88 | `^ -> &` |
| `src/address-ranges.ts` | 90 | `& -> |` |
| `src/address-ranges.ts` | 90 | `&& -> \|\|` |
| `src/address-ranges.ts` | 90 | `== -> !=` |
| `src/address-ranges.ts` | 90 | `\|\| -> &&` |
| `src/address-ranges.ts` | 98 | `< -> <=` |
| `src/address-ranges.ts` | 99 | `< -> <=` |
| `src/address-ranges.ts` | 111 | `true -> false` |
| `src/address-ranges.ts` | 151 | `> -> >=` |
| `src/address-ranges.ts` | 155 | `!= -> ==` |
| `src/announce-errors.ts` | 52 | `== -> !=` |
| `src/announce-errors.ts` | 107 | `> -> <` |
| `src/announce-keys.ts` | 51 | `\|\| -> &&` |
| `src/announce-keys.ts` | 83 | `>> -> <<` |
| `src/announce-keys.ts` | 104 | `false -> true` |
| `src/announce-keys.ts` | 109 | `false -> true` |
| `src/announce.ts` | 75 | `false -> true` |
| `src/announce.ts` | 104 | `<= -> <` |
| `src/announce.ts` | 110 | `> -> >=` |
| `src/announcement-reads.ts` | 119 | `\|\| -> &&` |
| `src/announcement-reads.ts` | 142 | `&& -> \|\|` |
| `src/announcement-reads.ts` | 142 | `+ -> -` |
| `src/announcement-reads.ts` | 142 | `>= -> >` |
| `src/announcement-reads.ts` | 160 | `< -> <=` |
| `src/announcement-reads.ts` | 160 | `< -> >` |
| `src/announcement-reads.ts` | 160 | `> -> >=` |
| `src/announcement-reads.ts` | 162 | `< -> <=` |
| `src/announcement-reads.ts` | 162 | `< -> >` |
| `src/announcement-reads.ts` | 162 | `== -> !=` |
| `src/announcement-reads.ts` | 179 | `&& -> \|\|` |
| `src/announcement-reads.ts` | 179 | `< -> <=` |
| `src/announcement-reads.ts` | 184 | `< -> <=` |
| `src/announcement-reads.ts` | 193 | `> -> <` |
| `src/announcement-reads.ts` | 193 | `> -> >=` |
| `src/announcement-reads.ts` | 238 | `< -> <=` |
| `src/announcement-reads.ts` | 238 | `> -> <` |
| `src/announcement-reads.ts` | 238 | `> -> >=` |
| `src/announcement-sends.ts` | 66 | `>> -> <<` |
| `src/announcement-sends.ts` | 153 | `< -> <=` |
| `src/announcement-sends.ts` | 207 | `!= -> ==` |
| `src/announcement-sends.ts` | 208 | `< -> <=` |
| `src/announcement-sends.ts` | 208 | `< -> >` |
| `src/budget.ts` | 26 | `- -> +` |
| `src/budget.ts` | 27 | `== -> !=` |
| `src/budget.ts` | 30 | `* -> /` |
| `src/budget.ts` | 30 | `- -> +` |
| `src/budget.ts` | 30 | `/ -> *` |
| `src/budget.ts` | 51 | `< -> <=` |
| `src/budget.ts` | 51 | `< -> >` |
| `src/budget.ts` | 110 | `> -> <` |
| `src/budget.ts` | 112 | `> -> >=` |

## Build

1. **Tests.** Add tests in `packages/client/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill client survivors in other files at the same time. Put your tests in new files whose names start with `kill-client-announce-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the client tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
