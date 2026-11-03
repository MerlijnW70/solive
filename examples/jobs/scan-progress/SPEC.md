# Job: One unreadable job must never hide the others from find_jobs (N3)

On the released `@intent-engine/cli@0.1.80`, `solive_find_jobs` with no filter answers 0 jobs on every call on public devnet with the same `more` cursor, while `jobs` on the CLI lists 14. Any open job whose spec cannot be read in time causes it: no url with no copy anywhere, a hash that does not match its url, or `publish_spec` off. A spec read that fails can now take up to `SPEC_READ_MS` across its sources, and the scan in `packages/cli/src/job-pages.ts` (`scanned`) has a budget of `SCAN_BUDGET_MS` over a whole batch. When the budget ends, it stops at the first unfinished read, `at` does not move, and the answer tells the agent to call again with the same cursor, for ever. `all: true` stalls too. Anyone can hide all older jobs with one small escrow. The walk report is in `F:\solive-kit\kill-wave\fresh-hirer-walk\report.md`; its client `tools/follow.mjs` beside it reproduces this.

## Build

1. **Every call makes progress.** A scan never returns a `more` equal to the cursor it was given while jobs remain. A slow job at the head holds up neither the jobs in its batch that finished nor the ones after it.
2. **A bound per job.** Each job's read within a scan has its own time bound, well below `SCAN_BUDGET_MS`, and a job that does not finish in it is passed over for this call. This goes for the whole read, including the history lookup that `all: true` also needs. Find out what holds up `all: true`, and fix that cause rather than only bounding it.
3. **Passed over is said.** The answer holds a count of jobs passed over for time, and the plain text says how to read one (`solive_get_spec` on its intent). A job proven unreadable is not listed, as today. A job passed over only for time is not called unreadable.
4. **Slow jobs get found later.** A read that was passed over goes on in the background within its own existing budget, and its outcome is kept in memory with bounds on count and age, so a later call lists a readable job at once, and passes over a known unreadable one with no wait. Sealed and invite rules are unchanged: the outcome is kept per escrow, and a kept "readable" answer may not make a sealed job read as open. Keep to the rules in `packages/client/src/job-specs.ts`.
5. **Bounded cost.** A list with many unreadable jobs costs each call at most its budget, and an agent that follows `more` reaches the end of the list in a number of calls bounded by the number of jobs, shown by a test. Node and gateway requests in the background stay bounded per process.
6. **Other callers.** `packages/cli/src/agent/jobs.ts`, the CLI `jobs`, `job-wait.ts` and the worker tool keep working, and get the same fix if they share the stall. Check them.

## Tests

Each fails if its behaviour breaks: a head job whose read never ends leaves `more` advancing and later jobs listed, on the first call; following `more` over a list of unreadable and readable jobs mixed reaches every readable job in a bounded number of calls, with fake time; the same with `all: true`; the passed-over count and text are right; a readable slow job shows up on a later call without a new wait; a known unreadable job costs no new wait; kept outcomes are per escrow, so two escrows with one hash, one sealed, stay apart; the kept set stays within its bounds. Show the fix against public devnet with `tools/follow.mjs`, using the built package in place of npm, and report the output.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines, new logic in new files.
- No program change. Additions only to public exports and tool outputs.
- Do not touch `packages/cli/src/agent/settle.ts`, `create.ts`, `wallet/escrow.ts` or `faucet.ts`; another job is changing them. Another job is changing how `packages/client/src/rpc-transport.ts` builds filters: leave that file alone.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
