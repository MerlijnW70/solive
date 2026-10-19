# Job: a stand-by line for claimed jobs (T-74)

A cooldown bars only the last wallet that dropped a claim, so a worker with a second wallet can drop, claim and drop with it and claim again in one transaction, holding a job without it ever being free to anyone else (threat-model row T-74, `crates/intent-core/src/claim.rs`, `programs/intent_engine/src/instructions/claim_job.rs`, `drop_claim.rs`). Solive has no users yet, so the claim board layout may change without a version flag.

## Build

- A first-in, first-out stand-by line per claim board: `head` and `tail` on the board and one entry account per waiting worker, seeded so it cannot collide with any existing seed (threat-model row T-82).
- `stand_by(secs)`: any worker joins the line while the job is held, locking the board's stake in its entry; `secs` at most the board's `max_secs`.
- While anyone waits, `claim_job` is refused; `drop_claim` hands the board to the head of the line in the same instruction; a permissionless `advance` forfeits a lapsed holder's stake to the owner exactly as a lapse does today and hands the board to the head; `leave` lets a waiter take its stake and rent back, and anyone may close entries once the escrow is no longer open. Entries whose accounts are gone are skipped.
- A pure line model in `crates/intent-core` with a property test: a worker standing at position k holds the job within k terms, whatever the wallets ahead of it do.
- SDK and `intent-engine claims standby|leave|advance`, and the line length in `solive_find_jobs` and `intent-engine jobs`.

## Rules

- Cancel, settle, payment rules and the cooldown are otherwise unchanged; every existing claims test still passes.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update `docs/judge.md` (claims) in at most five sentences, the T-74 and T-82 rows in `docs/maintainers/threat-model.md`, and `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: today's two-wallet renewal refused while a worker waits; the line served in order; a lapsed holder advanced past with its stake forfeited to the owner; holes skipped; every waiter refunded after a cancel; and the layout-preimage test extended to the new seed.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
