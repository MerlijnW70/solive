# Job: Kill the mutants the night of 2026-11-01 left alive

The mutation run at `bb42cc6` leaves mutants alive in `packages/core` and `packages/client`, in code added for the local worker and the program-wide activity read. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `bb42cc67c163be194bd156def39cc8228a8a3b15`. `a -> b` means operator `a` on that line became `b`. For `==`, the mutant is `===` becoming `!==`. `true -> false` flips a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `packages/core/src/memo.ts` | 23 | `== -> !=` |
| `packages/client/src/client-activity.ts` | 71 | `>= -> >` |
| `packages/client/src/client-activity.ts` | 151 | `< -> <=` |
| `packages/client/src/rpc-limits.ts` | 13 | `== -> !=` |
| `packages/client/src/rpc-limits.ts` | 53 | `< -> <=` |
| `packages/client/src/rpc-limits.ts` | 75 | `&& -> \|\|` |
| `packages/client/src/rpc-limits.ts` | 85 | `true -> false` |
| `packages/client/src/rpc-limits.ts` | 109 | `true -> false` |
| `packages/client/src/rpc-shapes.ts` | 18 | `& -> \|` |
| `packages/client/src/rpc-shapes.ts` | 109 | `& -> \|` |
| `packages/client/src/rpc-shapes.ts` | 165 | `& -> \|` |

## Build

1. **Tests.** Add or tighten tests under `packages/core/test` and `packages/client/test` so each runtime mutant above makes at least one test fail. Assert exact boundaries: the edge value accepted, one past it refused, and the refusal's class, field and rule where the code names them. For the `{ once: true }` rows, show that a listener left behind after the first abort or wait changes behaviour (a second call, a reused signal, or a count of listeners).
2. **Type-only mutants.** The `rpc-shapes.ts` rows change a type intersection, which has no runtime effect. Rewrite each of those types so that no operator mutant on it can type-check and survive: for example an `interface` that `extends`, or a single object type, with the same fields. Keep the exported names and shapes identical, so the API reports do not change.
3. **Equivalent mutants.** If another row cannot change any behaviour, say so in the report with one sentence on why. Do not change the source for it, except under item 2.
4. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only test files, and the three types under item 2, unless a real bug needs a source fix. Public exports stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the package's tests fail, or for item 2 the mutant no longer type-checks; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
