# Job: add-to works the first time on a fresh Windows machine

The first-run walk found that `add-to` misreads a missing app on Windows and fails on a second paste (plan item 4).

## Build

1. **Missing app.** Detect that `codex` or `claude` is not installed by looking it up on PATH before running it (on Windows including PATHEXT), not by exit code. Then print one plain sentence naming the app and the official install command for it, and exit non-zero. No raw shell error text reaches the user.
2. **Already added.** Running `add-to` again when the server is already registered succeeds (exit 0) and says it is already set up, for both apps. Replacing stays a separate, explicit step.
3. **Execution policy.** When `add-to` runs from Windows PowerShell, nothing it prints asks the user to run a `.ps1` shim; any command it prints for Windows uses `npx.cmd`.

Files: `packages/cli/src/add-to.ts`, `packages/cli/src/launch.ts`.

## Tests

Missing app on Windows and on Linux (stub PATH and launcher); a second run for each app; printed Windows commands use `npx.cmd`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Change only the files named above and their tests; other workers change other first-run files in parallel.
- Read `docs/maintainers/first-run.md` (Walk log, Plan) for the observed behaviour this job fixes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
