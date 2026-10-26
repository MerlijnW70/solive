# Bounty: held split shares on chain (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H16, aimed at the code that changed since round H14: held split shares, the claim cooldown on every path, mandate checks, the multisig review of IDL updates and the SDK's held-share reads.

## Scope

programs/intent_engine/src: attested.rs (release_split, push_withheld), policy.rs (accepts_payout, pay_out_split, split_net, fee_leg), instructions/claim_held.rs, close_intent.rs and close_announcement.rs (the held guards), fill_intent.rs and begin_fill.rs (withheld fees), and every fill_attested_split* path; state.rs `held` fields and HELD_CLAIM_SECS.

## Invariants

- **HS-1**: Every base unit a split release takes from the vault reaches the recipient the split names, is held for exactly that recipient, or is withheld as a fee with an event naming it; the amounts add up to the escrow to the base unit, and a held share leaves the vault only through claim_held to its recipient or, after HELD_CLAIM_SECS, back to the escrow's owner.
- **HS-2**: claim_held pays only the wallet the split names at that index, exactly the share the release computed for it, at most once, into an account that wallet owns; the announcement's and the intent's held markers change only as the shares they mark are claimed.
- **HS-3**: close_intent and close_announcement never close an account a held share still needs before the documented time, and no account can be closed twice or its rent paid to anyone but the payer who funded it.
- **HS-4**: No setting a recipient, partner, judge or the fee recipient puts on its own token account stops the other recipients from being paid, or leaves an escrow that can be neither released nor refunded.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, a release the attestor (or committee quorum) never signed, or a multisig action the review did not show. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_hs_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `hs1_two_shares_paid_for_one`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
