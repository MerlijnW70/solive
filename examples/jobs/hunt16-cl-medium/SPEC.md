# Bounty: claims, stakes and the stand-by line (medium)

This escrow pays 0.1 SOL for one medium finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H16, aimed at the code that changed since round H14: held split shares, the claim cooldown on every path, mandate checks, the multisig review of IDL updates and the SDK's held-share reads.

## Scope

programs/intent_engine/src: claims.rs (hand_over, cooldown_of, stake_receiver), instructions/claim_job.rs, drop_claim.rs, stand_by.rs, leave.rs, advance.rs, settle_claims.rs, open_claims.rs, open_claims_listed.rs, list_claimants.rs, extend_claimants.rs, and the claim checks inside every release, cancel and expire path; crates/intent-core/src/claim.rs.

## Invariants

- **CL-1**: Every lamport paid into a claim board or a stand-by entry ends at the worker, the owner or the next served worker exactly as the program's stake rules say, and once the escrow is closed the board and every entry can still be closed by someone with nothing left behind.
- **CL-2**: A worker is granted the claim only through a path the rules allow: never while another holds it within its time, never inside its own cooldown (directly or through the line), never off a claim list that restricts the job, and never ahead of a live entry earlier in the line.
- **CL-3**: While a claim holds, no release pays anyone other than its holder; once it lapses or is dropped, a release, cancel or expiry is never blocked by the board or the line.

## What a medium finding is

A smaller invariant break: misleading output about shares, claims or payouts, or a guard that holds only by accident and a test shows it. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_cl_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `cl1_two_shares_paid_for_one`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
