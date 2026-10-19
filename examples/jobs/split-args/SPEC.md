# Job: split the argument parser

`packages/cli/src/args.ts` holds the whole `parse` function and is over the 500-line limit `CONTRIBUTING.md` sets.

## Build

- Move parts of `args.ts` into new modules under `packages/cli/src` so that every changed or new file is at most 400 lines.
- This is a pure refactor: every export of `args.ts` stays exported from `args.ts` with the same name, type and behaviour, every message stays byte for byte the same, and no test changes except imports.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Follow the naming of the existing `arg-*.ts` modules.
- Change only `packages/cli/src`, and `packages/cli/test` imports if a test must import a moved name.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. `git diff --stat` shows no test file changing beyond import lines, and `docs/reference` is unchanged.
3. Every file the patch touches under `packages/cli/src` is at most 400 lines.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
