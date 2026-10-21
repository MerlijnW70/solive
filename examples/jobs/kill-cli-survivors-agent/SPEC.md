# Job: Kill the surviving cli mutants in the agent and wallet tools

The mutation run at `57b0d3b` leaves mutants alive in `packages/cli`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `57b0d3b37f18ad2108f0b49504a68e4cc910ca9f`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/add-to.ts` | 65 | `< -> <=` |
| `src/add-to.ts` | 68 | `+ -> -` |
| `src/add-to.ts` | 68 | `< -> <=` |
| `src/add-to.ts` | 76 | `+ -> -` |
| `src/add-to.ts` | 76 | `> -> >=` |
| `src/agent/actions.ts` | 72 | `!= -> ==` |
| `src/agent/actions.ts` | 73 | `< -> <=` |
| `src/agent/actions.ts` | 73 | `< -> >` |
| `src/agent/actions.ts` | 73 | `> -> <` |
| `src/agent/actions.ts` | 73 | `> -> >=` |
| `src/agent/create.ts` | 123 | `- -> +` |
| `src/agent/create.ts` | 123 | `> -> <` |
| `src/agent/create.ts` | 123 | `> -> >=` |
| `src/agent/mcp.ts` | 54 | `|| -> &&` |
| `src/agent/problems.ts` | 318 | `> -> >=` |
| `src/agent/problems.ts` | 318 | `|| -> &&` |
| `src/agent/problems.ts` | 325 | `+ -> -` |
| `src/agent/problems.ts` | 331 | `> -> >=` |
| `src/agent/problems.ts` | 331 | `|| -> &&` |
| `src/agent/problems.ts` | 335 | `+ -> -` |
| `src/agent/profile.ts` | 92 | `== -> !=` |
| `src/agent/profile.ts` | 131 | `&& -> ||` |
| `src/agent/profile.ts` | 131 | `== -> !=` |
| `src/agent/profile.ts` | 132 | `&& -> ||` |
| `src/agent/profile.ts` | 156 | `== -> !=` |
| `src/agent/reputation.ts` | 81 | `+ -> -` |
| `src/agent/reputation.ts` | 85 | `+ -> -` |
| `src/agent/reputation.ts` | 118 | `== -> !=` |
| `src/agent/reputation.ts` | 121 | `== -> !=` |
| `src/agent/reputation.ts` | 180 | `== -> !=` |
| `src/agent/reputation.ts` | 180 | `true -> false` |
| `src/agent/wallet/attest.ts` | 123 | `+ -> -` |
| `src/agent/wallet/attest.ts` | 213 | `false -> true` |
| `src/agent/wallet/attest.ts` | 219 | `|| -> &&` |
| `src/agent/wallet/attest.ts` | 224 | `== -> !=` |
| `src/agent/wallet/committee.ts` | 157 | `&& -> ||` |
| `src/agent/wallet/committee.ts` | 157 | `> -> >=` |
| `src/agent/wallet/committee.ts` | 158 | `> -> >=` |
| `src/agent/wallet/delivery.ts` | 241 | `== -> !=` |
| `src/agent/wallet/delivery.ts` | 251 | `!= -> ==` |
| `src/agent/wallet/delivery.ts` | 273 | `== -> !=` |
| `src/agent/wallet/delivery.ts` | 365 | `== -> !=` |
| `src/agent/wallet/escrow.ts` | 81 | `true -> false` |
| `src/agent/wallet/escrow.ts` | 97 | `+ -> -` |
| `src/agent/wallet/escrow.ts` | 109 | `- -> +` |
| `src/agent/wallet/guard.ts` | 198 | `== -> !=` |
| `src/agent/wallet/guard.ts` | 277 | `<= -> <` |
| `src/agent/wallet/guard.ts` | 436 | `> -> >=` |
| `src/agent/wallet/history.ts` | 59 | `> -> >=` |
| `src/agent/wallet/history.ts` | 68 | `- -> +` |
| `src/agent/wallet/openings.ts` | 67 | `== -> !=` |
| `src/agent/wallet/openings.ts` | 96 | `== -> !=` |
| `src/agent/wallet/receipt.ts` | 90 | `&& -> ||` |
| `src/agent/wallet/receipt.ts` | 90 | `== -> !=` |
| `src/agent/wallet/record.ts` | 166 | `> -> <` |
| `src/agent/wallet/record.ts` | 166 | `> -> >=` |
| `src/agent/wallet/split.ts` | 185 | `+ -> -` |
| `src/agent/wallet/split.ts` | 188 | `> -> >=` |
| `src/agent/wallet/split.ts` | 191 | `> -> <` |
| `src/agent/wallet/split.ts` | 191 | `> -> >=` |
| `src/agent/wallet/split.ts` | 260 | `&& -> ||` |
| `src/agent/wallet/split.ts` | 260 | `> -> >=` |
| `src/agent/wallet/split.ts` | 268 | `> -> >=` |
| `src/agent/wallet/split.ts` | 269 | `!= -> ==` |
| `src/agent/wallet/split.ts` | 297 | `== -> !=` |
| `src/agent/wallet/split.ts` | 313 | `== -> !=` |
| `src/agent/wallet/trade.ts` | 46 | `<= -> <` |
| `src/agent/wallet/wait.ts` | 26 | `< -> <=` |
| `src/agent/work-claims.ts` | 112 | `> -> <` |
| `src/agent/work-claims.ts` | 159 | `== -> !=` |
| `src/agent/work-claims.ts` | 161 | `== -> !=` |

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
