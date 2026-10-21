# Job: Kill the surviving cli mutants in the commands and arguments

The mutation run at `57b0d3b` leaves mutants alive in `packages/cli`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `57b0d3b37f18ad2108f0b49504a68e4cc910ca9f`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/admin-commands.ts` | 357 | `!= -> ==` |
| `src/admin-commands.ts` | 357 | `== -> !=` |
| `src/admin-commands.ts` | 357 | `>= -> >` |
| `src/arg-admin.ts` | 74 | `< -> <=` |
| `src/args.ts` | 117 | `&& -> ||` |
| `src/args.ts` | 163 | `&& -> ||` |
| `src/claim-commands.ts` | 64 | `== -> !=` |
| `src/claim-commands.ts` | 151 | `|| -> &&` |
| `src/claim-commands.ts` | 161 | `> -> >=` |
| `src/claim-commands.ts` | 177 | `> -> >=` |
| `src/commands.ts` | 141 | `false -> true` |
| `src/committee-commands.ts` | 104 | `|| -> &&` |
| `src/committee-commands.ts` | 108 | `|| -> &&` |
| `src/committee-commands.ts` | 111 | `== -> !=` |
| `src/committee-commands.ts` | 118 | `!= -> ==` |
| `src/committee-commands.ts` | 226 | `|| -> &&` |
| `src/job-commands.ts` | 56 | `== -> !=` |
| `src/job-filters.ts` | 26 | `== -> !=` |
| `src/job-filters.ts` | 26 | `> -> >=` |
| `src/job-filters.ts` | 59 | `false -> true` |
| `src/ledger-keys.ts` | 50 | `!= -> ==` |
| `src/legacy-commands.ts` | 32 | `|| -> &&` |
| `src/legacy-commands.ts` | 33 | `false -> true` |
| `src/legacy-commands.ts` | 36 | `< -> <=` |
| `src/legacy-commands.ts` | 36 | `> -> <` |
| `src/legacy-commands.ts` | 36 | `|| -> &&` |
| `src/legacy-commands.ts` | 37 | `false -> true` |
| `src/legacy-commands.ts` | 40 | `< -> <=` |
| `src/legacy-commands.ts` | 77 | `> -> >=` |
| `src/legacy-commands.ts` | 82 | `true -> false` |
| `src/legacy-commands.ts` | 94 | `== -> !=` |
| `src/legacy-commands.ts` | 94 | `|| -> &&` |
| `src/legacy-commands.ts` | 95 | `== -> !=` |
| `src/legacy-commands.ts` | 109 | `- -> +` |
| `src/main.ts` | 170 | `* -> /` |
| `src/main.ts` | 177 | `true -> false` |
| `src/migrate-commands.ts` | 19 | `+ -> -` |
| `src/migrate-commands.ts` | 49 | `* -> /` |
| `src/migrate-commands.ts` | 53 | `+ -> -` |
| `src/migrate-commands.ts` | 54 | `+ -> -` |
| `src/migrate-commands.ts` | 55 | `> -> <` |
| `src/migrate-commands.ts` | 55 | `> -> >=` |
| `src/migrate-commands.ts` | 56 | `> -> >=` |
| `src/migrate-commands.ts` | 82 | `< -> <=` |
| `src/migrate-commands.ts` | 138 | `* -> /` |
| `src/migrate-commands.ts` | 138 | `+ -> -` |
| `src/monitor.ts` | 223 | `> -> >=` |
| `src/sealed-commands.ts` | 45 | `> -> >=` |
| `src/sealed-commands.ts` | 80 | `|| -> &&` |
| `src/wallet.ts` | 87 | `false -> true` |
| `src/wallet.ts` | 170 | `>= -> >` |

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
