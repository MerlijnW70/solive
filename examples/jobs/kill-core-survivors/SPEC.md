# Job: Kill the surviving core mutants

The mutation run at `1565eb2` leaves mutants alive in `packages/core`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `1565eb245b36238c5ae8fb71d481a8b4c6866e3a`, files under `packages/core`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line, such as an `extractable` flag.

| File | Line | Mutant |
|---|---|---|
| `src/claims.ts` | 123 | `> -> >=` |
| `src/claims.ts` | 127 | `== -> !=` |
| `src/claims.ts` | 128 | `== -> !=` |
| `src/claims.ts` | 129 | `== -> !=` |
| `src/claims.ts` | 147 | `== -> !=` |
| `src/committee.ts` | 173 | `+ -> -` |
| `src/committee.ts` | 189 | `false -> true` |
| `src/committee.ts` | 189 | `|| -> &&` |
| `src/committee-floors.ts` | 33 | `> -> >=` |
| `src/committee-floors.ts` | 33 | `< -> <=` |
| `src/encryption-key.ts` | 74 | `false -> true` |
| `src/fee.ts` | 65 | `<= -> <` |
| `src/fee.ts` | 71 | `<= -> <` |
| `src/migrate.ts` | 55 | `&& -> ||` |
| `src/mint-caps.ts` | 61 | `> -> >=` |
| `src/sealed.ts` | 73 | `false -> true` |
| `src/sealed.ts` | 78 | `false -> true` |
| `src/sealed.ts` | 90 | `false -> true` |
| `src/sealed.ts` | 95 | `true -> false` |
| `src/sealed.ts` | 97 | `false -> true` |
| `src/sealed.ts` | 164 | `false -> true` |
| `src/sealed.ts` | 169 | `false -> true` |
| `src/sealed-delivery.ts` | 51 | `+ -> -` |
| `src/sealed-delivery.ts` | 55 | `- -> +` |
| `src/sealed-delivery.ts` | 55 | `+ -> -` |
| `src/sealed-delivery.ts` | 74 | `* -> /` |
| `src/sealed-delivery.ts` | 80 | `> -> >=` |
| `src/sealed-delivery.ts` | 87 | `== -> !=` |
| `src/sealed-delivery.ts` | 150 | `&& -> ||` |
| `src/sealed-delivery.ts` | 150 | `!= -> ==` |
| `src/sealed-delivery.ts` | 150 | `== -> !=` |
| `src/sealed-delivery.ts` | 158 | `false -> true` |
| `src/sealed-delivery.ts` | 179 | `true -> false` |
| `src/sealed-delivery.ts` | 188 | `<< -> >>` |
| `src/sealed-delivery.ts` | 193 | `false -> true` |
| `src/sealed-delivery.ts` | 214 | `|| -> &&` |
| `src/sealed-delivery.ts` | 217 | `> -> >=` |
| `src/sealed-delivery.ts` | 255 | `< -> <=` |
| `src/sealed-delivery.ts` | 264 | `false -> true` |
| `src/sealed-delivery.ts` | 267 | `true -> false` |
| `src/sealed-delivery.ts` | 297 | `> -> >=` |
| `src/sealed-delivery.ts` | 297 | `|| -> &&` |
| `src/sealed-delivery.ts` | 314 | `false -> true` |
| `src/sealed-delivery.ts` | 336 | `> -> >=` |
| `src/sealed-delivery.ts` | 336 | `|| -> &&` |
| `src/sealed-delivery.ts` | 340 | `> -> <` |
| `src/sig.ts` | 149 | `< -> <=` |
| `src/sig.ts` | 452 | `- -> +` |
| `src/sig.ts` | 456 | `> -> >=` |
| `src/sig.ts` | 460 | `> -> >=` |
| `src/sig.ts` | 470 | `> -> >=` |
| `src/versions.ts` | 111 | `< -> <=` |
| `src/versions.ts` | 121 | `< -> <=` |
| `src/versions.ts` | 121 | `+ -> -` |
| `src/versions.ts` | 134 | `< -> <=` |
| `src/versions.ts` | 168 | `== -> !=` |
| `src/versions.ts` | 169 | `== -> !=` |
| `src/versions.ts` | 170 | `== -> !=` |
| `src/versions.ts` | 171 | `== -> !=` |

## Build

1. **Tests.** Add or tighten tests in `packages/core/test` so each mutant above makes at least one test fail. Assert observable behaviour: thrown errors, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), key properties such as `extractable`, and byte layouts.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, you may instead simplify the source so the line no longer has that operator or literal, with behaviour unchanged. Name each such case in the report with one sentence on why it was equivalent.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/core`. Public exports and their signatures stay as they are.
- Do not weaken or delete existing tests.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the core tests fail; or the report names it as equivalent and the source no longer contains it.
3. The report lists every row as killed, removed as equivalent, or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.