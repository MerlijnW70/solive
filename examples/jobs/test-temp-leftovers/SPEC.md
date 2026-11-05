# Job: Test runs and judge runs leave nothing in the temp directory (M2)

**Rules:**
1. After `pnpm -r test` ends, by pass, fail or interrupt, the system temp directory holds no entry that the run created.
2. A CLI command that creates a temp directory removes it on every exit path: success, error, refusal and SIGINT.

On the dev host, one day of paid rounds left about 62,000 directories in `/tmp`, nearly all from the test suites. Known sites:
- `packages/cli/test/harness-state.ts`, with `solive-sales-` dirs made at import time;
- `packages/cli/test/judge-kit.ts`, with `judge-` dirs per job;
- `packages/cli/test/ci-steady.test.ts`, `packages/cli/test/judge-draw.test.ts`, `packages/cli/test/encryption-job.ts` and `packages/cli/test/word-count.test.ts`.

These are examples only. About 95 test files and helpers in `packages/*/test` call `mkdtemp`, `mkdtempSync` or `mktemp`.

## Build

1. **Find every site.** Search the whole repo for every place that creates a temp file or directory: `mkdtemp`, `mkdtempSync`, `mktemp`, `tmpdir()`, and spawned CLI processes or scripts that create their own. Cover tests, test helpers, `packages/*/src` (at least `packages/cli/src/delivery-fetch.ts`, `packages/cli/src/artifact.ts` and `packages/cli/src/sandbox-doctor.ts`) and `scripts/*.sh`. List each site in the report with how it is now cleaned.
2. **Fix tests.** Make every test run satisfy rule 1. Pick one mechanism and reuse it everywhere. Either works:
   - per-file cleanup;
   - a run-scoped temp root that every package's vitest config sets, inherited by spawned processes, and removed when the run ends.

   A run that dies without cleanup, such as one killed with SIGKILL, must not leak forever. The next run removes run roots whose owning process is gone, and never touches a root whose process is alive or any entry it did not create.
3. **Fix product code.** Make every `packages/*/src` site satisfy rule 2. Reuse one cleanup path. Keep file modes and the `wx` flags as they are. Do not change what any command prints or returns.
4. **Fix scripts.** Every `scripts/*.sh` that makes a temp path checks that `mktemp` succeeded and removes the path on exit with a `trap`.

## Tests

- **A guard test or script** that runs one package's full suite with a fresh temp directory and fails when any entry is left behind. Run it for every package and include its output in the report.
- **An interrupt test:** a run killed partway leaves a stale root that the next run removes, while a live run's root survives.
- **A rule 2 test** for each product site, covering the error and refusal paths.
- **The existing suites** of every package still pass.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only test files, test helpers, vitest configs, the product sites found in item 1, `scripts/*.sh`, and the generated references. No program change. Do not weaken any test's assertions.
- Never remove a path built from an empty or unset value. Every recursive removal checks that the path is inside the temp root it owns.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The guard output shows zero leftover entries for every package.
3. A review confirms every site from item 1 is covered and no cleanup can reach outside its own root.

## Deliver

One `git format-patch` file, plus the site list and guard output. Announce its sha256 to the judge.
