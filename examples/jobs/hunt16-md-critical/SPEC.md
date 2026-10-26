# Bounty: agent mandates and nonce lanes (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H16, aimed at the code that changed since round H14: held split shares, the claim cooldown on every path, mandate checks, the multisig review of IDL updates and the SDK's held-share reads.

## Scope

programs/intent_engine/src: instructions/create_mandate.rs, revoke_mandate.rs, create_intent_by_agent.rs, advance_epoch.rs, admission.rs, and the cancel, expire and fill paths for intents a mandate opened; crates/intent-core/src/mandate.rs.

## Invariants

- **MD-1**: An agent never opens an intent beyond its mandate: per intent (agent fee included), in total, in count, in lifetime, after valid_until, outside its kinds, below its price floor, or with accounts, mints or partner terms other than the mandate's.
- **MD-2**: After revoke_mandate or advance_epoch the agent opens nothing, and no nonce is ever accepted for two intents of one owner across lanes, mandates and the owner's own nonces.
- **MD-3**: The owner can always recover an intent an agent opened, escrow and agent fee, to the base unit, through cancel or expiry, and no one but the owner and the program's documented payees receives any of it.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, a release the attestor (or committee quorum) never signed, or a multisig action the review did not show. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_md_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `md1_two_shares_paid_for_one`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
