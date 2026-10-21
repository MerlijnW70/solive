# Job: Kill the surviving cli mutants in releases, the event feed and monitor arguments

The mutation run at `557e021` leaves mutants alive in `packages/cli`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `557e021f80c52534edda893efc6bde014214e30d`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. When a line holds the operator more than once, the row stands for each occurrence.

| File | Line | Mutant |
|---|---|---|
| `src/agent/wallet/releases.ts` | 87 | `< -> >` |
| `src/agent/wallet/releases.ts` | 100 | `< -> <=` |
| `src/agent/wallet/releases.ts` | 114 | `<= -> <` |
| `src/agent/wallet/releases.ts` | 116 | `>= -> <=` |
| `src/agent/wallet/releases.ts` | 116 | `>= -> >` |
| `src/agent/wallet/releases.ts` | 132 | `+= -> -=` |
| `src/agent/wallet/releases.ts` | 132 | `< -> <=` |
| `src/agent/wallet/releases.ts` | 139 | `> -> >=` |
| `src/agent/wallet/releases.ts` | 142 | `&& -> ||` |
| `src/agent/wallet/releases.ts` | 154 | `< -> >` |
| `src/agent/wallet/releases.ts` | 154 | `|| -> &&` |
| `src/agent/wallet/releases.ts` | 177 | `true -> false` |
| `src/agent/wallet/releases.ts` | 183 | `<= -> <` |
| `src/agent/wallet/releases.ts` | 183 | `<= -> <` |
| `src/agent/wallet/releases.ts` | 183 | `<= -> >=` |
| `src/agent/wallet/releases.ts` | 190 | `< -> >` |
| `src/agent/wallet/releases.ts` | 191 | `== -> !=` |
| `src/agent/wallet/releases.ts` | 191 | `|| -> &&` |
| `src/agent/wallet/releases.ts` | 194 | `+ -> -` |
| `src/agent/wallet/releases.ts` | 202 | `&& -> ||` |
| `src/agent/wallet/releases.ts` | 215 | `< -> <=` |
| `src/agent/wallet/releases.ts` | 216 | `< -> <=` |
| `src/agent/wallet/releases.ts` | 216 | `< -> >` |
| `src/agent/wallet/releases.ts` | 218 | `< -> >` |
| `src/agent/wallet/releases.ts` | 221 | `< -> <=` |
| `src/agent/wallet/releases.ts` | 224 | `true -> false` |
| `src/agent/wallet/releases.ts` | 233 | `true -> false` |
| `src/agent/wallet/releases.ts` | 239 | `< -> >` |
| `src/agent/wallet/releases.ts` | 239 | `|| -> &&` |
| `src/agent/wallet/releases.ts` | 272 | `&& -> ||` |
| `src/agent/wallet/releases.ts` | 289 | `|| -> &&` |
| `src/agent/wallet/releases.ts` | 295 | `&& -> ||` |
| `src/agent/wallet/releases.ts` | 295 | `>= -> >` |
| `src/event-feed.ts` | 35 | `- -> +` |
| `src/monitor-args.ts` | 24 | `<= -> <` |

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
