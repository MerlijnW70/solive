# Job: Kill the surviving solver mutants

The mutation run at `0650e77` leaves mutants alive in `packages/solver`. Each one changes a single operator on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `0650e7766374f0e9e1620713840998d296d63eb2`, files under `packages/solver`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse.

| File | Line | Mutant |
|---|---|---|
| `src/bundle.ts` | 42 | `< -> <=` |
| `src/float.ts` | 17 | `\|\| -> &&` |
| `src/float.ts` | 17 | `!= -> ==` |
| `src/float.ts` | 51 | `> -> <` |
| `src/float.ts` | 51 | `> -> >=` |
| `src/holds.ts` | 8 | `> -> >=` |
| `src/inventory.ts` | 31 | `< -> <=` |
| `src/inventory.ts` | 39 | `< -> <=` |

## Build

1. **Tests.** Add or tighten tests in `packages/solver/test` so each mutant above makes at least one test fail. Assert observable behaviour: exact boundaries, returned values and which intents are chosen.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, you may instead simplify the source so the line no longer has that operator, with behaviour unchanged. Name each such case in the report with one sentence on why it was equivalent.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/solver`. Public exports and their signatures stay as they are.
- Do not weaken or delete existing tests.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the solver tests fail; or the report names it as equivalent and the source no longer contains it.
3. The report lists every row as killed, removed as equivalent, or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.