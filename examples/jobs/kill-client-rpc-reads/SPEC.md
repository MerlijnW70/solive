# Job: Kill the surviving client mutants in the transport, retries and simple reads

The mutation run at `2947897` leaves 91 mutants alive in `packages/client`, in `src/memoized-transport.ts`, `src/observe.ts`, `src/pinned-fetch.ts`, `src/public-host.ts`, `src/refutation-standing.ts`, `src/release-plan.ts`, `src/release-reads.ts`, `src/reputation.ts`, `src/rpc-retry.ts`, `src/rpc-shapes.ts`, `src/rpc-transport.ts`, `src/send-errors.ts`, `src/setup.ts`, `src/shown.ts`, `src/simple-orders.ts`, `src/simple-reads.ts`, `src/simple-tokens.ts`, `src/simple-work.ts`, `src/simple.ts`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `29478977c15576a02bd380ec6cb8e065b3931275`, files under `packages/client`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/memoized-transport.ts` | 8 | `\|\| -> &&` |
| `src/observe.ts` | 57 | `- -> +` |
| `src/observe.ts` | 80 | `&& -> \|\|` |
| `src/observe.ts` | 80 | `== -> !=` |
| `src/observe.ts` | 149 | `false -> true` |
| `src/pinned-fetch.ts` | 24 | `== -> !=` |
| `src/pinned-fetch.ts` | 24 | `true -> false` |
| `src/pinned-fetch.ts` | 56 | `< -> >` |
| `src/pinned-fetch.ts` | 56 | `> -> >=` |
| `src/pinned-fetch.ts` | 56 | `\|\| -> &&` |
| `src/pinned-fetch.ts` | 61 | `true -> false` |
| `src/public-host.ts` | 4 | `true -> false` |
| `src/refutation-standing.ts` | 31 | `>> -> <<` |
| `src/release-plan.ts` | 94 | `- -> +` |
| `src/release-plan.ts` | 97 | `- -> +` |
| `src/release-plan.ts` | 98 | `> -> >=` |
| `src/release-plan.ts` | 99 | `> -> >=` |
| `src/release-plan.ts` | 144 | `< -> <=` |
| `src/release-plan.ts` | 144 | `\|\| -> &&` |
| `src/release-reads.ts` | 18 | `&& -> \|\|` |
| `src/release-reads.ts` | 18 | `>= -> >` |
| `src/release-reads.ts` | 47 | `== -> !=` |
| `src/release-reads.ts` | 105 | `< -> >` |
| `src/release-reads.ts` | 105 | `\|\| -> &&` |
| `src/release-reads.ts` | 113 | `\|\| -> &&` |
| `src/release-reads.ts` | 137 | `< -> <=` |
| `src/release-reads.ts` | 137 | `< -> >` |
| `src/reputation.ts` | 55 | `< -> <=` |
| `src/reputation.ts` | 91 | `< -> <=` |
| `src/reputation.ts` | 91 | `< -> >` |
| `src/reputation.ts` | 91 | `> -> <` |
| `src/reputation.ts` | 91 | `> -> >=` |
| `src/reputation.ts` | 92 | `&& -> \|\|` |
| `src/reputation.ts` | 136 | `/ -> *` |
| `src/reputation.ts` | 137 | `< -> <=` |
| `src/reputation.ts` | 137 | `< -> >` |
| `src/reputation.ts` | 138 | `> -> <` |
| `src/reputation.ts` | 138 | `> -> >=` |
| `src/reputation.ts` | 148 | `== -> !=` |
| `src/rpc-retry.ts` | 15 | `< -> <=` |
| `src/rpc-retry.ts` | 89 | `>= -> >` |
| `src/rpc-retry.ts` | 114 | `false -> true` |
| `src/rpc-retry.ts` | 118 | `&& -> \|\|` |
| `src/rpc-retry.ts` | 118 | `< -> <=` |
| `src/rpc-retry.ts` | 118 | `< -> >` |
| `src/rpc-retry.ts` | 118 | `>= -> <=` |
| `src/rpc-retry.ts` | 118 | `>= -> >` |
| `src/rpc-retry.ts` | 120 | `<= -> <` |
| `src/rpc-retry.ts` | 120 | `<= -> >=` |
| `src/rpc-retry.ts` | 120 | `>= -> >` |
| `src/rpc-shapes.ts` | 103 | `& -> |` |
| `src/rpc-shapes.ts` | 106 | `& -> |` |
| `src/rpc-shapes.ts` | 157 | `& -> |` |
| `src/rpc-transport.ts` | 111 | `== -> !=` |
| `src/rpc-transport.ts` | 111 | `\|\| -> &&` |
| `src/rpc-transport.ts` | 140 | `> -> <` |
| `src/rpc-transport.ts` | 140 | `> -> >=` |
| `src/rpc-transport.ts` | 145 | `> -> >=` |
| `src/rpc-transport.ts` | 150 | `false -> true` |
| `src/rpc-transport.ts` | 226 | `== -> !=` |
| `src/rpc-transport.ts` | 235 | `< -> <=` |
| `src/rpc-transport.ts` | 300 | `< -> <=` |
| `src/rpc-transport.ts` | 334 | `true -> false` |
| `src/rpc-transport.ts` | 382 | `!= -> ==` |
| `src/send-errors.ts` | 96 | `== -> !=` |
| `src/send-errors.ts` | 120 | `& -> |` |
| `src/setup.ts` | 44 | `\|\| -> &&` |
| `src/setup.ts` | 51 | `>= -> >` |
| `src/setup.ts` | 58 | `- -> +` |
| `src/setup.ts` | 61 | `- -> +` |
| `src/shown.ts` | 24 | `+ -> -` |
| `src/shown.ts` | 24 | `>= -> >` |
| `src/shown.ts` | 30 | `>= -> >` |
| `src/shown.ts` | 33 | `+ -> -` |
| `src/simple-orders.ts` | 54 | `== -> !=` |
| `src/simple-orders.ts` | 115 | `>= -> >` |
| `src/simple-orders.ts` | 122 | `== -> !=` |
| `src/simple-reads.ts` | 48 | `false -> true` |
| `src/simple-reads.ts` | 74 | `true -> false` |
| `src/simple-reads.ts` | 95 | `== -> !=` |
| `src/simple-reads.ts` | 109 | `&& -> \|\|` |
| `src/simple-tokens.ts` | 72 | `< -> <=` |
| `src/simple-tokens.ts` | 72 | `> -> >=` |
| `src/simple-tokens.ts` | 92 | `&& -> \|\|` |
| `src/simple-tokens.ts` | 92 | `== -> !=` |
| `src/simple-tokens.ts` | 100 | `!= -> ==` |
| `src/simple-work.ts` | 29 | `== -> !=` |
| `src/simple-work.ts` | 74 | `- -> +` |
| `src/simple-work.ts` | 94 | `- -> +` |
| `src/simple.ts` | 57 | `== -> !=` |
| `src/simple.ts` | 81 | `== -> !=` |

## Build

1. **Tests.** Add tests in `packages/client/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill client survivors in other files at the same time. Put your tests in new files whose names start with `kill-client-rpc-reads-`. Change an existing test file only if every test in it covers the files in the table.
- Change source only for a real bug, and only in the files in the table. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the client tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
