# Bounty: delivery v4 on chain, across instructions (medium)

This escrow pays 0.1 SOL for one medium finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of audit round H14, aimed at the code that changed since rounds H12 and H13: the signing tools, delivery v4 across instructions, reputation, sealed delivery and the judge.

## Scope

programs/intent_engine/src/instructions: announce_delivery, sync_committee_keys, close_announcement, close_delivery_book, refute_release, set_announce_fee, close_legacy, and every fill_attested* path that consumes an announcement; crates/intent-core/src/delivery.rs. Round H12 hunted these one instruction at a time; this round looks for sequences of instructions.

## Invariants

- **DV-1**: While an escrow is open, its announcements carry the seqs 1..n once each and its delivery book's next seq is n+1, whatever sequence of announce, close, refute, settle and sync transactions comes in between.
- **DV-2**: No close, refute, sync or legacy-close instruction removes or changes an announcement, a delivery book or a committee key snapshot that a release of a still-open escrow, or a later refutation, depends on.
- **DV-3**: Lamports are conserved across every sequence: announcement and book rent go back only to the payer who funded them, the announce fee only to the configured fee recipient, and no account can be closed twice or refunded to anyone else.
- **DV-4**: A refutation is recorded only against a release of the same escrow, by a worker whose earlier announcement on it (lower seq, not a payee of that release) opens to the paid work, and at most once per earlier announcement.

## What a medium finding is

A smaller invariant break: misleading output about deliveries or payouts, or a guard that holds only by accident and a test shows it. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; wallet-slot fingerprints being checked by the client rather than the program; a mint's freeze authority (T-83); delivered code noticing that it is being judged; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it); reputation scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_dv_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `dv1_two_announcements_share_a_seq`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
