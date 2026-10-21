# Job: Kill the surviving cli mutants in the judge, sandbox and process code

The mutation run at `57b0d3b` leaves mutants alive in `packages/cli`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `57b0d3b37f18ad2108f0b49504a68e4cc910ca9f`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/container-check.ts` | 8 | `false -> true` |
| `src/container-check.ts` | 10 | `true -> false` |
| `src/container-check.ts` | 27 | `== -> !=` |
| `src/container-check.ts` | 37 | `!= -> ==` |
| `src/container-check.ts` | 38 | `true -> false` |
| `src/container-check.ts` | 43 | `== -> !=` |
| `src/container-check.ts` | 47 | `false -> true` |
| `src/container-check.ts` | 59 | `true -> false` |
| `src/container-check.ts` | 61 | `* -> /` |
| `src/container-check.ts` | 81 | `!= -> ==` |
| `src/container-check.ts` | 81 | `|| -> &&` |
| `src/delivery-fetch.ts` | 36 | `> -> >=` |
| `src/delivery-fetch.ts` | 45 | `> -> >=` |
| `src/delivery-fetch.ts` | 61 | `!= -> ==` |
| `src/delivery-fetch.ts` | 67 | `&& -> ||` |
| `src/draw.ts` | 68 | `- -> +` |
| `src/draw.ts` | 69 | `+ -> -` |
| `src/draw.ts` | 69 | `- -> +` |
| `src/draw.ts` | 111 | `<= -> <` |
| `src/draw.ts` | 135 | `== -> !=` |
| `src/draw.ts` | 151 | `< -> <=` |
| `src/draw.ts` | 151 | `> -> >=` |
| `src/draw.ts` | 151 | `|| -> &&` |
| `src/draw.ts` | 157 | `<= -> <` |
| `src/draw.ts` | 178 | `== -> !=` |
| `src/draw.ts` | 194 | `> -> >=` |
| `src/draw.ts` | 195 | `> -> >=` |
| `src/draw.ts` | 204 | `> -> >=` |
| `src/draw.ts` | 225 | `- -> +` |
| `src/judge-digest.ts` | 20 | `< -> >` |
| `src/judge-digest.ts` | 20 | `> -> <` |
| `src/judge-digest.ts` | 20 | `|| -> &&` |
| `src/judge-watch.ts` | 23 | `< -> <=` |
| `src/judge-watch.ts` | 23 | `< -> >` |
| `src/judge-watch.ts` | 23 | `> -> <` |
| `src/judge-watch.ts` | 23 | `> -> >=` |
| `src/judge-watch.ts` | 33 | `|| -> &&` |
| `src/judge-watch.ts` | 34 | `false -> true` |
| `src/judge-watch.ts` | 37 | `> -> >=` |
| `src/judge.ts` | 114 | `|| -> &&` |
| `src/launch.ts` | 16 | `true -> false` |
| `src/mcp-smoke.ts` | 37 | `> -> <` |
| `src/mcp-smoke.ts` | 68 | `&& -> ||` |
| `src/mcp-smoke.ts` | 73 | `== -> !=` |
| `src/mcp-smoke.ts` | 101 | `|| -> &&` |
| `src/mcp-smoke.ts` | 124 | `< -> <=` |
| `src/mcp-smoke.ts` | 163 | `|| -> &&` |
| `src/mcp-smoke.ts` | 175 | `&& -> ||` |
| `src/mcp-smoke.ts` | 176 | `|| -> &&` |
| `src/process-reap.ts` | 34 | `== -> !=` |
| `src/process-reap.ts` | 41 | `&& -> ||` |
| `src/process-reap.ts` | 56 | `!= -> ==` |
| `src/process-reap.ts` | 59 | `|| -> &&` |
| `src/process-reap.ts` | 61 | `false -> true` |
| `src/process-reap.ts` | 79 | `&& -> ||` |
| `src/process-reap.ts` | 79 | `>= -> >` |
| `src/process-reap.ts` | 89 | `<= -> <` |
| `src/process-reap.ts` | 101 | `> -> >=` |
| `src/process-reap.ts` | 108 | `|| -> &&` |
| `src/process-reap.ts` | 109 | `> -> <` |
| `src/process-reap.ts` | 109 | `> -> >=` |
| `src/process-reap.ts` | 116 | `> -> >=` |
| `src/process-reap.ts` | 122 | `* -> /` |
| `src/process-reap.ts` | 129 | `true -> false` |
| `src/process-table.ts` | 11 | `+ -> -` |
| `src/process-table.ts` | 66 | `>= -> >` |
| `src/process-table.ts` | 74 | `true -> false` |
| `src/solve-stats.ts` | 35 | `* -> /` |
| `src/solve-stats.ts` | 48 | `- -> +` |
| `src/solve-stats.ts` | 51 | `+ -> -` |
| `src/viper.ts` | 59 | `< -> <=` |
| `src/viper.ts` | 59 | `> -> >=` |
| `src/viper.ts` | 73 | `|| -> &&` |

## Build

1. **Tests.** Add or tighten tests in `packages/cli/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, you may instead simplify the source so the line no longer has that operator or literal, with behaviour unchanged. Name each such case in the report with one sentence on why it was equivalent.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/cli`, and only the files above and their tests. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent and the source no longer contains it.
3. The report lists every row as killed, removed as equivalent, or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
