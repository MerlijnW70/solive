# Job: Kill the surviving cli mutants in the agent wallet tools

The mutation run at `7afd3ef` leaves 103 mutants alive in `packages/cli` under `src/agent/wallet/`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `7afd3efa89f8f1dde321cf2c28311628e7adc89e`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/agent/wallet/attest.ts` | 89 | `\|\| -> &&` |
| `src/agent/wallet/attest.ts` | 122 | `<= -> <` |
| `src/agent/wallet/attest.ts` | 206 | `> -> >=` |
| `src/agent/wallet/attest.ts` | 209 | `&& -> \|\|` |
| `src/agent/wallet/attest.ts` | 209 | `> -> >=` |
| `src/agent/wallet/attest.ts` | 227 | `> -> >=` |
| `src/agent/wallet/committee.ts` | 77 | `\|\| -> &&` |
| `src/agent/wallet/committee.ts` | 172 | `false -> true` |
| `src/agent/wallet/committee.ts` | 279 | `!= -> ==` |
| `src/agent/wallet/costs.ts` | 24 | `* -> /` |
| `src/agent/wallet/costs.ts` | 24 | `+ -> -` |
| `src/agent/wallet/costs.ts` | 42 | `&& -> \|\|` |
| `src/agent/wallet/costs.ts` | 45 | `false -> true` |
| `src/agent/wallet/costs.ts` | 100 | `> -> <` |
| `src/agent/wallet/costs.ts` | 100 | `> -> >=` |
| `src/agent/wallet/delivery.ts` | 58 | `\|\| -> &&` |
| `src/agent/wallet/delivery.ts` | 93 | `false -> true` |
| `src/agent/wallet/delivery.ts` | 102 | `&& -> \|\|` |
| `src/agent/wallet/delivery.ts` | 122 | `== -> !=` |
| `src/agent/wallet/delivery.ts` | 262 | `&& -> \|\|` |
| `src/agent/wallet/delivery.ts` | 262 | `< -> <=` |
| `src/agent/wallet/delivery.ts` | 274 | `== -> !=` |
| `src/agent/wallet/delivery.ts` | 350 | `> -> <` |
| `src/agent/wallet/escrow-claims.ts` | 73 | `== -> !=` |
| `src/agent/wallet/escrow-claims.ts` | 78 | `== -> !=` |
| `src/agent/wallet/escrow.ts` | 54 | `== -> !=` |
| `src/agent/wallet/escrow.ts` | 97 | `> -> >=` |
| `src/agent/wallet/escrow.ts` | 100 | `< -> <=` |
| `src/agent/wallet/escrow.ts` | 100 | `> -> >=` |
| `src/agent/wallet/escrow.ts` | 234 | `true -> false` |
| `src/agent/wallet/escrow.ts` | 428 | `true -> false` |
| `src/agent/wallet/guard.ts` | 478 | `&& -> \|\|` |
| `src/agent/wallet/guard.ts` | 478 | `< -> <=` |
| `src/agent/wallet/guard.ts` | 478 | `>= -> >` |
| `src/agent/wallet/held.ts` | 94 | `true -> false` |
| `src/agent/wallet/held.ts` | 97 | `== -> !=` |
| `src/agent/wallet/held.ts` | 102 | `== -> !=` |
| `src/agent/wallet/held.ts` | 117 | `== -> !=` |
| `src/agent/wallet/history-profit.ts` | 43 | `< -> <=` |
| `src/agent/wallet/history-profit.ts` | 60 | `== -> !=` |
| `src/agent/wallet/history-profit.ts` | 61 | `- -> +` |
| `src/agent/wallet/history-profit.ts` | 84 | `!= -> ==` |
| `src/agent/wallet/history-profit.ts` | 85 | `+= -> -=` |
| `src/agent/wallet/history-profit.ts` | 88 | `-= -> +=` |
| `src/agent/wallet/history-work.ts` | 64 | `true -> false` |
| `src/agent/wallet/history-work.ts` | 68 | `&& -> \|\|` |
| `src/agent/wallet/history-work.ts` | 68 | `< -> <=` |
| `src/agent/wallet/history-work.ts` | 68 | `< -> >` |
| `src/agent/wallet/history-work.ts` | 68 | `== -> !=` |
| `src/agent/wallet/history-work.ts` | 80 | `< -> <=` |
| `src/agent/wallet/history-work.ts` | 112 | `&& -> \|\|` |
| `src/agent/wallet/history-work.ts` | 126 | `!= -> ==` |
| `src/agent/wallet/history-work.ts` | 130 | `== -> !=` |
| `src/agent/wallet/history-work.ts` | 146 | `> -> >=` |
| `src/agent/wallet/history-work.ts` | 148 | `&& -> \|\|` |
| `src/agent/wallet/history-work.ts` | 178 | `> -> >=` |
| `src/agent/wallet/history-work.ts` | 243 | `== -> !=` |
| `src/agent/wallet/history-work.ts` | 244 | `== -> !=` |
| `src/agent/wallet/history-work.ts` | 264 | `== -> !=` |
| `src/agent/wallet/history-work.ts` | 291 | `&& -> \|\|` |
| `src/agent/wallet/history-work.ts` | 304 | `> -> >=` |
| `src/agent/wallet/history.ts` | 38 | `>= -> >` |
| `src/agent/wallet/history.ts` | 43 | `false -> true` |
| `src/agent/wallet/history.ts` | 93 | `!= -> ==` |
| `src/agent/wallet/history.ts` | 93 | `\|\| -> &&` |
| `src/agent/wallet/history.ts` | 116 | `== -> !=` |
| `src/agent/wallet/history.ts` | 128 | `== -> !=` |
| `src/agent/wallet/history.ts` | 143 | `true -> false` |
| `src/agent/wallet/history.ts` | 152 | `> -> >=` |
| `src/agent/wallet/openings.ts` | 44 | `== -> !=` |
| `src/agent/wallet/openings.ts` | 68 | `> -> <` |
| `src/agent/wallet/receipt.ts` | 25 | `== -> !=` |
| `src/agent/wallet/receipt.ts` | 93 | `&& -> \|\|` |
| `src/agent/wallet/receipt.ts` | 105 | `!= -> ==` |
| `src/agent/wallet/receipt.ts` | 144 | `!= -> ==` |
| `src/agent/wallet/receipt.ts` | 266 | `!= -> ==` |
| `src/agent/wallet/receipt.ts` | 266 | `&& -> \|\|` |
| `src/agent/wallet/receipt.ts` | 266 | `== -> !=` |
| `src/agent/wallet/receipt.ts` | 322 | `>= -> <=` |
| `src/agent/wallet/refute.ts` | 126 | `> -> <` |
| `src/agent/wallet/releases.ts` | 126 | `>= -> >` |
| `src/agent/wallet/seal.ts` | 58 | `> -> >=` |
| `src/agent/wallet/split.ts` | 130 | `- -> +` |
| `src/agent/wallet/split.ts` | 143 | `> -> <` |
| `src/agent/wallet/split.ts` | 143 | `> -> >=` |
| `src/agent/wallet/split.ts` | 144 | `> -> <` |
| `src/agent/wallet/split.ts` | 144 | `> -> >=` |
| `src/agent/wallet/split.ts` | 204 | `+ -> -` |
| `src/agent/wallet/split.ts` | 210 | `== -> !=` |
| `src/agent/wallet/standing.ts` | 38 | `< -> <=` |
| `src/agent/wallet/standing.ts` | 38 | `< -> >` |
| `src/agent/wallet/standing.ts` | 49 | `== -> !=` |
| `src/agent/wallet/standing.ts` | 66 | `== -> !=` |
| `src/agent/wallet/standing.ts` | 68 | `!= -> ==` |
| `src/agent/wallet/standing.ts` | 68 | `> -> <` |
| `src/agent/wallet/standing.ts` | 68 | `> -> >=` |
| `src/agent/wallet/standing.ts` | 68 | `true -> false` |
| `src/agent/wallet/standing.ts` | 68 | `\|\| -> &&` |
| `src/agent/wallet/work.ts` | 79 | `true -> false` |
| `src/agent/wallet/work.ts` | 86 | `!= -> ==` |
| `src/agent/wallet/work.ts` | 86 | `true -> false` |
| `src/agent/wallet/work.ts` | 102 | `!= -> ==` |
| `src/agent/wallet/work.ts` | 102 | `true -> false` |

## Build

1. **Tests.** Add tests in `packages/cli/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill cli survivors in other folders at the same time. Put your tests in new files whose names start with `kill-cli-wallet-survivors-`. Change an existing test file only if every test in it covers files under `src/agent/wallet/`.
- Change source only for a real bug, and only in files under `src/agent/wallet/`. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
