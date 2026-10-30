# Job: find_jobs answers fast and lists only jobs a worker can read

The first-run walk log records how long `solive_find_jobs` took next to Codex's default tool timeout, and every job it showed had no readable spec (plan item 6).

## Build

1. By default, list only open jobs whose spec can be read (a spec url, or a sealed spec the wallet can open), newest first, with a small default limit. An option includes the rest.
2. Answer within the time a host allows: read in bounded batches, stop at the limit, and return what was found with a `more` cursor instead of reading everything.
3. Measure before and after against devnet with the same query, and report both times.

Files: `packages/cli/src/agent/jobs.ts` and the code it calls in `packages/cli`; change `packages/client` only if the scan itself must change.

## Tests

The default filter drops jobs without a readable spec; the limit and cursor work; reads stay within the batch bound (stubbed transport counts calls).

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Change only the files named above and their tests; other workers change other first-run files in parallel.
- Read `docs/maintainers/first-run.md` (Walk log, Plan) for the observed behaviour this job fixes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
