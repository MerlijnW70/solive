# Bounty: break delivery v4, on-chain delivery announcements (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of an audit by bounty of delivery v4 (on-chain announcements), which went live on devnet on 2026-10-24.

## Scope

programs/intent_engine/src/instructions: announce_delivery, sync_committee_keys, close_announcement, close_delivery_book, refute_release, set_announce_fee; crates/intent-core/src/delivery.rs

## Invariants

- **DA-1**: While an escrow is open, every announcement on it gets a distinct seq, the seqs run 1..n with no gap, and the delivery book's next seq is n+1.
- **DA-2**: Only a worker the escrow lets deliver can announce: the claim holder while a claim is held, a listed worker when the board has an invite list; a blob whose recipients do not match the judge's published key or the committee's synced snapshot is refused.
- **DA-3**: Lamports are conserved: announcement and book rent go back only to the payer who funded them, only when the program's closing rules allow; the announce fee goes only to the configured fee recipient; nobody else can move or keep them.
- **DA-4**: A Refutation is recorded only by a worker whose earlier announcement on the same escrow (lower seq, not a payee of the release) has a commitment that opens to the paid work, at most once per earlier announcement.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, or standing that misstates a worker's record. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it).
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_da_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `da1_two_announcements_share_a_seq`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
