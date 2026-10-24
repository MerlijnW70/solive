# Job: Move the client onto on-chain announcements

On branch `v4-program` the program records deliveries as on-chain announcements with a strict per-escrow sequence (delivery v4), and a proof escrow settles only against the paid worker's announcement. `@intent-engine/core` already builds every new instruction (packages/core/src/delivery-builders.ts, the settlement builders in fill-builders.ts), seals the v4 format (packages/core/src/sealed-delivery-v4.ts) and computes the url limit (`maxSealedUrl`). `@intent-engine/client` still finds deliveries by paging through the judge's transaction history and records them in memos. This job moves the client to the accounts and removes the memo paths.

Read first: the program instructions in programs/intent_engine/src/instructions (`announce_delivery`, `sync_committee_keys`, `close_announcement`, `close_delivery_book`, `refute_release`, the four `fill_attested*`), the Rust tests in tests/svm/tests (`announcements.rs`, `committee_announcements.rs`, `delivery_release.rs`, `announcement_close.rs`, `refute.rs`, `announce_size.rs`), and the core files named above.

## Required

- `client.announce({ worker, payer?, intent, sha256, url })` announces a delivery. It reads the escrow, its attestor (a key judge or a committee), the judge's published key or the committee's synced key snapshot (sending `sync_committee_keys` first when a committee has not synced), the claims board and invite list when claims are open, and the announce fee; derives the salt and the v4 secrets from the worker's signature (a worker whose signer cannot sign messages passes its own 32 secret bytes instead, and keeps them); seals the blob; refuses before sending when the url is longer than `maxSealedUrl` allows for that transaction's shape (v0); and returns the announcement address, its seq, the commitment and the salt. Announcing the same blob again returns the existing announcement instead of failing.
- `client.announcements(intent)` returns every announcement of an escrow in seq order, the book's next seq, and whether the list is complete (every seq from 1 to the last one present). It reads accounts only, at a context slot no older than the client's own last confirmed write; it never reads transaction history. `client.announcementsTo(attestor)` and `client.announcementsBy(worker)` list across escrows.
- `client.firstOpening({ intent, sha256, keypair? })` walks the announcements in seq order and returns the first one that opens to `sha256` (address, seq, worker, salt, url), using only on-chain data: it refuses with a typed reason when an earlier announcement is sealed to a key the caller holds but does not open, when one is sealed to the judge's published key or committee key the caller did not give, or when the claim is held by a worker other than the first opener.
- `client.settleProof`, `client.settleCommittee` and the split settle take the announcement and its opening and sign the delivery preimages; the payee is the announcing worker's token account. Any wallet may send a judge-signed release (the old fee-payer restriction goes).
- `client.refute({ worker, earlier, paid, sha256, url, secret? })`, `client.reclaim({ worker })` (closes every announcement of that worker that the program lets close now, rent back to its payer) and `client.closeBook(intent)`.
- The simple layer (`connect`) delivers with `announce` and releases with `firstOpening` plus `settleProof`, keeping its summaries and previews.
- Delete what the accounts replace: delivery and opening memos, judge-history scanning for deliveries, the record of openings and release memos, and their exports. Keep `scan` only where other features still need history.
- docs/sdk-client.md describes the new calls; every new sentence is pinned by a test as the page's other sentences are.
- Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the Rust crates or packages/core except to fix a bug you can show with a test (report it). Keep TypeScript files under about 500 lines.
- Only packages/client and docs/sdk-client.md change. Reputation, trust and release standing (packages/client/src/reputation.ts, trust.ts, confirm-release.ts) are rewritten by a later job: keep them compiling against your changes with the smallest correct change, and say in the report what they now lack.
- packages/cli and packages/solver are adapted by a later job and may fail to typecheck; that is expected on this branch.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names: `cargo test --workspace` passes, packages/core passes `bash scripts/test.sh /mnt/f/solive all`, and packages/client passes its typecheck and every test.
2. A LiteSVM test announces from two workers for one escrow, the second with an earlier seq sealed to a key the judge holds; `firstOpening` returns the earliest that opens, and a release pays that worker through `settleProof`.
3. A LiteSVM test shows `firstOpening` refusing while an earlier announcement is sealed to the judge's published key and the judge passed no key, and succeeding once the key is passed.
4. A test with 2,000 spam announcements (a fake transport is fine) shows `announcements` complete and `firstOpening` finding the honest one; a test with one seq missing shows the list incomplete and the release refused.
5. A committee test: announce to an unsynced committee (the client syncs first), settle on member votes.
6. A test fails when the judge makes `firstOpening` skip an earlier announcement sealed to a key the caller did not give.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
