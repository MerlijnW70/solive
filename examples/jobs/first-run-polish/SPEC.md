# Job: Two small first-run fixes

The first-run walk found two small rough edges (plan items 10 and 11).

## Build

1. **Node version.** When the CLI starts on a Node.js older than the version `package.json` requires, it prints one plain sentence naming the found and required versions and the download link, and exits non-zero, before anything else runs.
2. **Stray output.** `sandbox doctor` printed a stray `Killed` line in WSL. Find where it comes from and keep it out of the output, without hiding a real failure.

Files: the CLI entry (`packages/cli/src/bin.ts` or where startup runs) and `packages/cli/src/sandbox-doctor.ts`.

## Tests

The version check with a stubbed `process.versions.node`; the doctor output has no stray shell job-control lines.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Change only the files named above and their tests; other workers change other first-run files in parallel.
- Read `docs/maintainers/first-run.md` (Walk log, Plan) for the observed behaviour this job fixes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
