# Job: Kill the surviving cli mutants in sales, owner, mandates, shapes and monitor fills

The mutation run at `557e021` leaves mutants alive in `packages/cli`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `557e021f80c52534edda893efc6bde014214e30d`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. When a line holds the operator more than once, the row stands for each occurrence.

| File | Line | Mutant |
|---|---|---|
| `src/monitor-fills.ts` | 26 | `== -> !=` |
| `src/monitor-fills.ts` | 49 | `== -> !=` |
| `src/monitor-fills.ts` | 55 | `!= -> ==` |
| `src/agent/mandate-grant.ts` | 135 | `> -> >=` |
| `src/agent/mandate-grant.ts` | 136 | `> -> >=` |
| `src/agent/mandate-grant.ts` | 151 | `|| -> &&` |
| `src/agent/mandate-state.ts` | 60 | `- -> +` |
| `src/agent/mandate-state.ts` | 60 | `- -> +` |
| `src/agent/mandate-state.ts` | 87 | `< -> <=` |
| `src/agent/owner.ts` | 34 | `&& -> ||` |
| `src/agent/owner.ts` | 34 | `+ -> -` |
| `src/agent/owner.ts` | 34 | `<= -> <` |
| `src/agent/owner.ts` | 34 | `< -> <=` |
| `src/agent/owner.ts` | 74 | `> -> >=` |
| `src/agent/owner.ts` | 90 | `> -> >=` |
| `src/agent/sales.ts` | 73 | `&& -> ||` |
| `src/agent/sales.ts` | 73 | `&& -> ||` |
| `src/agent/sales.ts` | 73 | `== -> !=` |
| `src/agent/sales.ts` | 87 | `* -> /` |
| `src/agent/sales.ts` | 87 | `- -> +` |
| `src/agent/sales.ts` | 110 | `true -> false` |
| `src/agent/sales.ts` | 123 | `&& -> ||` |
| `src/agent/sales.ts` | 127 | `< -> <=` |
| `src/agent/sales.ts` | 128 | `true -> false` |
| `src/agent/sales.ts` | 142 | `true -> false` |
| `src/agent/sales.ts` | 165 | `true -> false` |
| `src/agent/sales.ts` | 166 | `false -> true` |
| `src/agent/sales.ts` | 174 | `false -> true` |
| `src/agent/sales.ts` | 188 | `false -> true` |
| `src/agent/sales.ts` | 190 | `&& -> ||` |
| `src/agent/sales.ts` | 194 | `false -> true` |
| `src/agent/sales.ts` | 198 | `true -> false` |
| `src/agent/sales.ts` | 210 | `&& -> ||` |
| `src/agent/sales.ts` | 215 | `true -> false` |
| `src/agent/sales.ts` | 221 | `> -> >=` |
| `src/agent/sales.ts` | 227 | `false -> true` |
| `src/agent/sales.ts` | 232 | `true -> false` |
| `src/agent/sales.ts` | 237 | `|| -> &&` |
| `src/agent/sales.ts` | 238 | `false -> true` |
| `src/agent/sales.ts` | 240 | `true -> false` |
| `src/agent/sales.ts` | 259 | `>= -> >` |
| `src/agent/shapes.ts` | 126 | `!= -> ==` |

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/cli`, and only the files above and their tests. Public exports, commands and tool names stay as they are.
- A mutant that no test can catch because the code behaves the same either way is equivalent: rewrite the line so the mutant no longer exists, keeping behaviour, and say why in the report.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent and the source no longer contains it.
3. The report lists every row as killed, removed as equivalent, or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
