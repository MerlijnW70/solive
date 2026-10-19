# Job: split the judge's process checker

`packages/cli/src/check-process.ts` runs the operator's check and reaps every process it leaves behind. It is close to the 500-line limit `CONTRIBUTING.md` sets.

## Build

- Move parts of `check-process.ts` into new modules under `packages/cli/src` so that every changed or new file is at most 300 lines.
- This is a pure refactor: every export of `check-process.ts` stays exported from it with the same name, type and behaviour, every message stays byte for byte the same, and no test changes except imports.

## Rules

- Keep the process-table reading, the reaping and the spawning each in one place; do not duplicate logic between modules.
- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/cli/src`, and `packages/cli/test` imports if a test must import a moved name.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. `git diff --stat` shows no test file changing beyond import lines, and `docs/reference` is unchanged.
3. Every file the patch touches under `packages/cli/src` is at most 300 lines.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
