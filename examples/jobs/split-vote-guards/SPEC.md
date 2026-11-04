# Job: Every committee-split signing guard has a test (F8)

The review of E1 found two guards in `packages/cli/src/agent/wallet/committee-split.ts` that no test covers.

## Build

1. **Vote approval.** Removing the approval check in `splitVote` (`input.approval !== approval`, which raises `VOTE_CHANGED`) passes every test. Without the check, a member's vote is signed, a Ledger vote included, with any approval or none.
2. **Quorum on sign-first.** Replacing `splitQuorum` with the raw vote list in `splitRelease` passes every test. The Ledger sign-first send never builds the plan, so without the check a Ledger would sign its co-author envelope over forged or non-member votes.

Add the missing tests. Change source only if a test shows a real defect.

## Tests

- A split vote with a wrong approval is refused and signs nothing, with a key file and with a Ledger.
- A Ledger sign-first release with a forged vote is refused, and so is one with a non-member vote. The device signs nothing in either case.
- Each test fails when its guard is removed. Show this in the delivery report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only test files under `packages/cli/test/`, and `committee-split.ts` only if a real defect is found. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
