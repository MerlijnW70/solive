# Job: Kill the surviving core mutants

The mutation run at `7afd3ef` leaves mutants alive in `packages/core`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `7afd3efa89f8f1dde321cf2c28311628e7adc89e`, files under `packages/core`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` flips a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position.

| File | Line | Mutant |
|---|---|---|
| `src/delivery-builders.ts` | 87 | `< -> <=` |
| `src/delivery-builders.ts` | 99 | `< -> <=` |
| `src/delivery-builders.ts` | 99 | `> -> >=` |
| `src/delivery.ts` | 77 | `< -> <=` |
| `src/delivery.ts` | 77 | `\|\| -> &&` |
| `src/delivery.ts` | 99 | `< -> <=` |
| `src/delivery.ts` | 99 | `> -> >=` |
| `src/delivery.ts` | 99 | `\|\| -> &&` |
| `src/ed25519.ts` | 70 | `> -> >=` |
| `src/errors.ts` | 31 | `\|\| -> &&` |
| `src/errors.ts` | 32 | `false -> true` |
| `src/errors.ts` | 34 | `== -> !=` |
| `src/fill-builders.ts` | 233 | `< -> <=` |
| `src/fill-builders.ts` | 233 | `> -> >=` |
| `src/fill-builders.ts` | 233 | `\|\| -> &&` |
| `src/fill-builders.ts` | 239 | `< -> <=` |
| `src/fill-builders.ts` | 239 | `>= -> >` |
| `src/fill-builders.ts` | 239 | `\|\| -> &&` |
| `src/sealed-delivery-v4.ts` | 293 | `\|\| -> &&` |
| `src/sealed.ts` | 209 | `\|\| -> &&` |

Three more survivors are equivalent and need no work: `src/delivery.ts:36` `< -> <=` (a 3-byte blob is refused later by its negative url length), `src/delivery.ts:44` `> -> >=` on `bytes.length > MAX_SEALED_BLOB` (a blob within the url cap is at most 619 bytes), and `src/sealed-delivery-v4.ts:237` `true -> false` (a replacement character fails `isMemoUrl`, so the result is `null` either way). Leave their lines as they are.

## Build

1. **Tests.** Add or tighten tests in `packages/core/test` so each mutant above makes at least one test fail. Assert exact boundaries: the edge value accepted, one past it refused, and the refusal's class, field and rule where the code names them.
2. **Equivalent mutants.** If a row above cannot change any behaviour, say so in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only test files under `packages/core/test`, unless a real bug needs a source fix. Public exports stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines; add a new file rather than growing one past that.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the core tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
