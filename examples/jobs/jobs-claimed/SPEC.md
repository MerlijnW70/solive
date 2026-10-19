# Job: show which jobs are claimed

`solive_find_jobs` and `intent-engine jobs` list open jobs without saying whether a worker holds a claim on one. A worker can do a claimed job and never be paid for it.

## Build

- Each job in `solive_find_jobs` and `intent-engine jobs` gains `claimed_by` (the wallet holding a live claim, or null) and `claim_ends` (when that claim lapses, or null), read with the client's claims view.
- A claim that has lapsed counts as no claim.
- `solive_find_jobs` and `intent-engine jobs` take an optional `unclaimed` filter (`--unclaimed`) that lists only jobs no one holds.
- Existing fields stay as they are.

## Rules

- Read the claim boards for the listed jobs in as few RPC calls as the client allows; never one round trip per field.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a job never claimed, a job with a live claim, a job whose claim lapsed, a job whose claim was dropped, the `unclaimed` filter in the command and the tool, and the same fields in both.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
