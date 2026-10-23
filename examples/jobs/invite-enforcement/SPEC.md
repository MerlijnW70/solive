# Job: Enforce invites on every path

A review of the invite-only job flow at 0.1.49 found that only `wallet_attest` and `intent-engine judge` check who a sealed spec was sealed to. Each gap below has a failing test in the review.

1. `wallet_attest_split` pays co-authors, and `wallet_committee_vote`, `wallet_committee_release` and the command line `committee vote` and `committee release` pay a payee, without checking the invite list.
2. The invite check passes silently when the sealed spec cannot be read at release time: an unreachable host, an error status, a body over the size `solive_get_spec` reads. A judge can then pay a wallet the spec was never sealed to.
3. A wallet that is not invited can take or queue a claim on an invite-only job with `wallet_claim` or `intent-engine claims take` and `claims standby`. The preview tells it only this wallet can be paid, it stakes what it cannot win back, and while its claim holds nobody can be paid: the invited worker is refused with `ClaimHeld`.
4. `wallet_deliver` does not tell an uninvited wallet that it cannot be paid, and `solive_get_claims` tells everyone an invite-only job is free to claim.
5. `wallet_attest`, `wallet_attest_split` and the committee tools release for a `delivered_sha256` that no announcement backs, paying whatever wallet is named.
6. The claim preview gives its end only as unix seconds, and the deliver and receipt outputs show the announcement's salt without saying whether it is safe to share.

## Required

- One shared invite check is used by every path that pays or votes to pay from a proof escrow: `wallet_attest`, every recipient of `wallet_attest_split`, `wallet_committee_vote`, `wallet_committee_release`, `intent-engine judge`, `committee vote` and `committee release`.
- When the escrow published a spec url and the spec there cannot be read, every such path refuses with a retryable refusal that says so, instead of skipping the check. Only an escrow with no spec url skips it.
- `wallet_claim` take and standby, and `intent-engine claims take` and `claims standby`, refuse a wallet a readable sealed spec is not sealed to, before anything is sent.
- `wallet_deliver` warns a wallet a sealed spec is not sealed to that it cannot be paid, and `solive_get_claims` says when a job is invite-only and names the invited wallets instead of calling it free to anyone.
- The release tools refuse a `delivered_sha256` that no announcement to the escrow backs, unless the call opts in with an input that says the work was received outside an announcement; the refusal names that input.
- The claim preview gives its end as a time and as seconds from now, and the outputs that show a salt say it becomes public once a release records it and is safe to share only after that.
- `docs/private-jobs.md` says that an uninvited wallet sending its own transaction can still hold a claim until it lapses, and advises keeping `claim_secs` short on invite-only jobs.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, `packages/client` where a shared helper is needed, `docs/private-jobs.md`, and the generated references and docs the tests check. No program change. Do not change `packages/core/src/sealed.ts`, `wallet_seal_spec`, `wallet_seal_work`, `wallet_fetch_work`, `solive_get_spec`, `wallet_escrow`, `wallet_escrow_plan`, `wallet_history`, `wallet_receipt` beyond the salt text, or the fetch helpers.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. LiteSVM tests show `wallet_attest_split` and `wallet_committee_vote` refusing an uninvited payee, `wallet_attest` refusing an uninvited payee when the sealed spec cannot be fetched, and `wallet_claim` refusing a take and a standby from an uninvited wallet.
3. A test fails when the judge makes the shared check skip on an unreadable spec again.
4. A test shows `wallet_attest` refusing an unannounced `delivered_sha256` and accepting it with the opt-in.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
