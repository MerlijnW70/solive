# Job: Close the gaps a second blind hire left

A second blind hirer and worker finished a full job on devnet with 0.1.45, with no failed calls. They reported these gaps.

1. The hirer put the expected file's sha256 in its spec. For work anyone can compute, that lets another wallet build the file and announce it first: the earliest announcer is paid. Nothing in `wallet_escrow` warns against it or points to claims, which reserve a job for one worker.
2. The worker could only host its work at a public url with a guessable name, so it could not follow the advice in `wallet_deliver` to use a url nobody but the judge knows. No tool or guide says how to do that without private hosting.
3. These outputs carry fields no description explains: `result` in `wallet_receipt` (for example `"1"`), and `pay_to` beside `payee` in the attest preview and the receipt. The `check` field in `wallet_check_delivery` has no description that says what a judge does with it.
4. `find_jobs` shows `sells` in raw units beside `net_pay` in whole tokens in one record, and gives no `next` hint when it finds nothing and was called without `wait`.
5. The escrow preview warns "this judge cannot use a Ledger for announced work: the profile of … publishes no encryption key". A hirer without a Ledger cannot tell whether it matters or what to do.

## Required

- `wallet_escrow` tells the hirer, within the tool text rules, not to publish the answer or its hash in the spec for work others could compute, and to use claims for such jobs.
- `wallet_deliver` and `docs/private-jobs.md` say how a worker without private hosting keeps the url unguessable, for example a long random path or name, and that it should announce right after hosting.
- Every output field named in item 3 has a description that says what it is, and `result` says what the value means for a proof escrow.
- `find_jobs` shows the amount the job pays in whole tokens next to `net_pay`, keeping `sells` as it is, and returns a `next` hint when nothing is found without `wait`.
- The Ledger warning says whom it affects and what that wallet can do, or is left out when it does not affect the hirer.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, `packages/client` for the warning text, `docs/private-jobs.md`, and the generated references and docs the tests check. No program change.
- Keep tool names and inputs as they are; add output fields only where a requirement asks for one. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. The judge reads every changed text, and each tells a first-time hirer or worker something true and actionable.
3. A test fails when the judge removes the new `find_jobs` hint for an empty result.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
