# Job: Kill the surviving cli mutants in the agent tools

The mutation run at `7afd3ef` leaves 32 mutants alive in `packages/cli` under `src/agent/`, outside `src/agent/wallet/`. Each one changes a single operator or literal on a line, and every test still passes. Write the tests that catch them.

## Survivors

Lines are at `7afd3efa89f8f1dde321cf2c28311628e7adc89e`, files under `packages/cli`. `a -> b` means operator `a` on that line became `b`. For `==` and `!=`, the mutant is the strict form: `===` became `!==`, or the reverse. `false -> true` and `true -> false` flip a boolean literal on the line. Where a line holds the operator more than once, kill the mutant at every position. The run hid Docker, so a row whose code only runs under Docker may already die once Docker is present; the judge checks every row with Docker present.

| File | Line | Mutant |
|---|---|---|
| `src/agent/claim-line.ts` | 38 | `== -> !=` |
| `src/agent/claim-line.ts` | 41 | `== -> !=` |
| `src/agent/claim-line.ts` | 51 | `&& -> \|\|` |
| `src/agent/claim-line.ts` | 51 | `< -> <=` |
| `src/agent/claim-line.ts` | 67 | `+ -> -` |
| `src/agent/claim-line.ts` | 83 | `!= -> ==` |
| `src/agent/claim-line.ts` | 83 | `&& -> \|\|` |
| `src/agent/claim-line.ts` | 107 | `== -> !=` |
| `src/agent/claim-line.ts` | 110 | `> -> >=` |
| `src/agent/claim-line.ts` | 131 | `+ -> -` |
| `src/agent/claim-line.ts` | 139 | `== -> !=` |
| `src/agent/claim-line.ts` | 142 | `== -> !=` |
| `src/agent/create.ts` | 140 | `> -> >=` |
| `src/agent/create.ts` | 226 | `> -> >=` |
| `src/agent/create.ts` | 256 | `\|\| -> &&` |
| `src/agent/jobs.ts` | 38 | `false -> true` |
| `src/agent/mandate-state.ts` | 121 | `<< -> >>` |
| `src/agent/mandate-state.ts` | 122 | `- -> +` |
| `src/agent/mandate-state.ts` | 147 | `< -> <=` |
| `src/agent/mandate-state.ts` | 147 | `> -> >=` |
| `src/agent/owner.ts` | 93 | `- -> +` |
| `src/agent/reputation.ts` | 118 | `== -> !=` |
| `src/agent/reputation.ts` | 119 | `== -> !=` |
| `src/agent/shapes.ts` | 174 | `* -> /` |
| `src/agent/spec.ts` | 26 | `== -> !=` |
| `src/agent/work-claims.ts` | 36 | `== -> !=` |
| `src/agent/work-claims.ts` | 220 | `== -> !=` |
| `src/agent/work-claims.ts` | 223 | `> -> >=` |
| `src/agent/work-claims.ts` | 228 | `>= -> >` |
| `src/agent/work-claims.ts` | 228 | `\|\| -> &&` |
| `src/agent/work-claims.ts` | 243 | `== -> !=` |
| `src/agent/work-claims.ts` | 252 | `\|\| -> &&` |

## Build

1. **Tests.** Add tests in `packages/cli/test` so each mutant above makes at least one test fail. Assert observable behaviour: exit codes, exact messages, exact boundaries, returned shapes (`toStrictEqual` where a key must be absent), and the order of results.
2. **Equivalent mutants.** If a mutant cannot change any behaviour, name it in the report with one sentence on why. Do not change the source for it.
3. **Real bugs.** If a mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Other workers kill cli survivors in other folders at the same time. Put your tests in new files whose names start with `kill-cli-agent-survivors-`. Change an existing test file only if every test in it covers files under `src/agent/`, outside `src/agent/wallet/`.
- Change source only for a real bug, and only in files under `src/agent/`, outside `src/agent/wallet/`. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests. Keep test files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. For every row, the judge applies the mutant by hand to the patched tree, and the cli tests fail; or the report names it as equivalent with a reason the judge confirms.
3. The report lists every row as killed, equivalent or fixed as a bug, with the test name that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
