# Job: Finish the claims lifecycle in the wallet tools

A third devnet job chain ran on 0.1.48. Workers now claim before working, but these gaps remain in the wallet tools; the command line already covers each with `intent-engine claims`.

1. After a release, each sub-job's claims board stays open holding its rent; `wallet_cancel` answers `NotFound` and no wallet tool closes the board. The contractor lost that rent on every sub-job. `claims settle` closes it, and collects a lapsed claim's stake for the owner.
2. A worker that finds a job claimed by another can only poll until the claim lapses, then race to claim it; `claims standby`, `claims leave` and `claims advance` queue workers for the job instead.
3. `solive_get_claims` reported `state: "free"` and `seconds_left: 0` for a job whose escrow was already released, so a worker kept polling a closed job.
4. The worker hints do not say to claim before hosting work.
5. The escrow previews list rent without saying which of it returns and when, so a contractor could not budget what it keeps.

## Required

- `wallet_claim` gains actions, with the same preview-first rules as `take` and `drop`, that settle a board (closing it when its escrow is gone, returning the rent to the owner, and moving a lapsed claim's stake as the program does), join and leave the stand-by line, and advance the line. Each preview says what moves to whom and what it costs.
- When a release or cancel leaves a board that can be closed, the `wallet_attest`, `wallet_attest_split` and `wallet_cancel` results say so and name the `wallet_claim` call that returns the rent.
- `solive_get_claims` says whether the escrow is still open, released or gone, and its `next` text stops pointing to a claim on a job that can no longer be paid.
- The `find_jobs` and `solive_get_spec` claim hints say to claim before hosting the work.
- The `wallet_escrow` and `wallet_escrow_plan` rent lines say which rent returns to this wallet and when, and which does not until the board is settled.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and `packages/client`, plus the generated references and docs the tests check. No program change. Do not change `wallet_deliver`, `wallet_receipt`, `wallet_history`, `solive_find_jobs` filters, the seal tools or the committee tools.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A LiteSVM test releases a claimed escrow with `wallet_attest`, then settles its board with `wallet_claim`, and shows the owner's SOL rising by the board's rent less the fee.
3. A LiteSVM test has one worker hold a claim and another join the stand-by line, lets the claim lapse, advances the line, and shows the waiting worker holding the claim.
4. A test fails when the judge removes the settle action's board close.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
