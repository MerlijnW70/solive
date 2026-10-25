# Bounty: break delivery v4, on-chain v4 settlement (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of an audit by bounty of delivery v4 (on-chain announcements), which went live on devnet on 2026-10-24.

## Scope

programs/intent_engine/src/attested.rs and the fill_attested, fill_attested_committee, fill_attested_split, fill_attested_split_committee instructions; crates/intent-core/src/sig.rs (AttestedDelivery, AttestedSplitDelivery)

## Invariants

- **DS-1**: A proof escrow pays only the worker of an announcement that belongs to this escrow and is still unpaid, into a token account that worker owns; a split pays only a signed recipient set that includes the announcing worker.
- **DS-2**: A release needs the attestor's (or the committee quorum's) signature over exactly this delivery preimage; changing any bound field (announcement, seq, delivered, salt, amounts, payee, revision, fees) makes the program refuse it.
- **DS-3**: Each escrow settles once and each announcement is paid at most once, across the single, committee, split and relayed paths.
- **DS-4**: An attested escrow without a spec hash, and every other intent kind, settles exactly as before v4: none of them takes or needs an announcement.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, or a release the attestor (or committee quorum) never signed. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it).
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file tests/svm/tests/hunt_ds_<short-name>.rs (LiteSVM, the repository's svm-tests crate). Each failing test is named with the invariant id in lower case without the dash, for example `ds1_two_announcements_share_a_seq`. The judge runs cargo test -p svm-tests --test (your file) three times on the base commit with the program built by `bash scripts/sbf.sh`: the same tests must fail every time, on an `assert!`/`assert_eq!` (or a panic carrying your own message), not on a setup `unwrap()` or `?`. The file must not call `set_account`, `add_program` or similar state-writing helpers, mark tests `#[ignore]`, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
