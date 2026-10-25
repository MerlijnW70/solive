# Job: Receipts survive a padded history, and reclaim keeps what can still refute

Audit round H14 found two client faults (packages/client/src):

- **RP-3/RP-4, padded receipt** (packages/client/test/hunt/rp-padded-receipt.test.ts): `receipt()` in simple-reads.ts reads the escrow with one `transport.engineTransactions(HISTORY_LIMIT, escrow)` call and never pages. Anyone can send 101 dust transfers to the escrow after its release; the release falls out of the window and the receipt reports `released: false`, no payee and `complete: true`.
- **Reclaim footgun** (observed by the sealed-delivery hunter): `reclaim` in announcement-sends.ts closes a worker's unpaid announcements as soon as the escrow is no longer open, without checking whether a later announcement was paid. An honest earlier worker who reclaims after a copier was paid destroys the announcement it needs to refute that release.

Round H14's delivery hunter also proved three sequences on chain and then deleted the tests: two closes of the same announcement in one transaction are refused; a third party cannot close an earlier announcement before the paid one (`AnnouncementRetained`) and a refutation in the window's last second works; after the delivery book closes, nobody can announce again.

## Required

1. `receipt()` finds the release however many other transactions touch the escrow: it pages the escrow's history the way the reputation path does, and it uses the escrow's on-chain status, so a filled escrow is never reported as not released. When paging stops at a limit before the release is found, `complete` is false and the reason says why.
2. `reclaim` keeps every announcement of the worker that could still refute a paid release of the same escrow (an earlier seq than the paid announcement, within the refutation window, not refuted yet), lists each kept one with that reason, and closes only the rest. A worker can still reclaim them once the window has passed.
3. The hunt test packages/client/test/hunt/rp-padded-receipt.test.ts is added unchanged from its delivery (it is in the H14 kit) and passes with the patch.
4. The three proved sequences become tests in tests/svm/tests (one file, named for what they protect).
5. Tests for each change, including a reclaim after a copier was paid and a reclaim after the window.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only packages/client, the new Rust test file, docs and generated references. Do not change the program. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The hunt test passes.
3. A test fails when the judge makes `receipt()` read a single history window again.
4. A test fails when the judge makes `reclaim` close an announcement that could still refute a paid release.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
