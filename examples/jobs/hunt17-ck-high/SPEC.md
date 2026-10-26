# Bounty: deadlines and time arithmetic (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H17, aimed at the code that changed since round H16: the claim cooldown and stake floor, overflow-free deadlines and the multisig review of what a proposal sets.

## Scope

crates/intent-core/src/clock.rs and every user of it: close_intent's held window, claim terms (Terms::until), stand-by service times (serve_until), mandate lifetimes (Limits::admit), the refutation and announcement windows (delivery::closable), mint-cap windows (mint_cap::charge), plus expire, cancel and auction decay; every expiry the program admits, up to i64::MAX, and every clock value.

## Invariants

- **CK-1**: Every deadline the program computes from an expiry or a stored time gives the answer its documentation states for every expiry admission accepts and every clock value, without an Overflow refusal on a legal value.
- **CK-2**: No escrow, announcement, claim board, stand-by entry or mint-cap window can be left in a state where nothing can ever close it or return its funds because of a time computation.
- **CK-3**: No time computation lets an action happen before its documented time (a claim past its term, a refutation window closed early, a mint-cap window reset early, a held share returned before its year).

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, a claim or mandate limit that does not hold, or an SDK read that misstates who was paid. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_ck_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `ck1_two_shares_paid_for_one`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
