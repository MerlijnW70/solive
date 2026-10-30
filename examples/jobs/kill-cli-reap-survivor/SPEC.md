# Job: Kill the surviving cli mutant in the process reaper

The mutation run at `2947897` leaves one mutant alive in `packages/cli`. It changes a single literal, and every test still passes. Write the test that catches it.

## Survivor

The line is at `29478977c15576a02bd380ec6cb8e065b3931275`, under `packages/cli`.

| File | Line | Mutant |
|---|---|---|
| `src/process-reap.ts` | 64 | `false -> true` |

The line is the last `return false` of `marked()`: a watch with neither a marker nor a working directory must never tie a running process to the check. The mutant used to die only because unrelated processes were running on the machine; inside a private PID namespace it survives.

## Build

1. **Test.** Add a test in `packages/cli/test`, in a new file whose name starts with `kill-cli-reap-survivor-`, that fails when the mutant is applied. It must not depend on other processes happening to run on the machine: start the unrelated process yourself.
2. **Real bug.** If the mutant shows a real bug, fix the source, add the test, and name it in the report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- A mutant in `src/process-reap.ts` can kill every process of your user, including your shell. Run any mutated suite inside `unshare --user --map-current-user --pid --fork --kill-child --mount-proc setsid --wait`.
- Change source only for a real bug. Public exports, commands and tool names stay as they are.
- Do not weaken or delete existing tests.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The judge applies the mutant by hand inside a private PID namespace, and the cli tests fail.
3. The report names the test that catches it.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
