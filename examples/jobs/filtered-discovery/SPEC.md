# Job: Find open jobs without downloading every escrow, and hear about new ones (J2)

`find_jobs` reads every intent account the program has ever left open, of every kind and status, on each call, and with `wait` it repeats that about once a second. On the public devnet node `getProgramAccounts` has a small method limit, so this hits rate-limit refusals and pushes jobs into `more`. The transport already supports memcmp filters on kind and status (`packages/client/src/intent-filters.ts`), but `openProofEscrows` and the pay path call it without any. A research report is in `F:\solive-kit\kill-wave\spec-store-stack\report.md`.

## Build

1. **Filtered reads.** `openProofEscrows` (`packages/client/src/job-proofs.ts`) and the job pay path (`packages/client/src/job-pay.ts`) ask the transport only for AttestedResult intents with status Open, using the existing filters. The result for callers is unchanged.
2. **Push for new jobs.** `intentNotifications` (`packages/client/src/intent-notifications.ts`) takes an optional `kind` and adds a memcmp on the kind byte. It must never filter on status, so that a job leaving Open still produces a notification.
3. **Wait without hammering.** `find_jobs` with `wait` uses the notifications to learn of new jobs and re-reads at a slow interval with backoff on 429, instead of a full scan about once a second. When notifications are not available, it falls back to polling at a bounded rate.

## Tests

Each fails if its behaviour breaks: a counting transport shows `openProofEscrows` passes the kind and status filters and returns the same jobs as before on a mixed set of accounts; the notification filter carries the kind and no status; a release or cancel of a job still produces a notification under the kind filter (on the local test program or a validator test, pinning the behaviour); one `wait` call makes a bounded number of `getProgramAccounts` calls; the fallback polls at the bounded rate.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Additions only to public exports and tool outputs.
- Touch only the files named above, their tests, and what `wait` needs in `packages/cli`; another job is changing the spec reading files in parallel.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
