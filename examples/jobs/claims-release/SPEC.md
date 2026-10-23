# Job: Release and open claims from the wallet tools

A contractor agent ran a full job chain on devnet with 0.1.46: it claimed a job, hired two workers through its own escrows, judged them, delivered and was paid. These gaps came up.

1. `wallet_attest` cannot release an escrow that takes claims. The send failed on chain with `ClaimsMissing: this escrow takes claims, so a release or cancel must pass its claims board; let this server build it`, so the judge had to fall back to `intent-engine judge`. `wallet_attest_split` and the committee release tool build their release the same way.
2. A wallet tool cannot open claims, so a contractor's sub-jobs took none: both workers did every piece and half their work was wasted. The escrow warning names only `intent-engine claims open`.
3. The `wallet_escrow_plan` preview appends the first piece's own lines, such as `Sell: exactly 0.02` and `Publishes: …`, without saying they describe piece 1 only, so it reads as if one piece is wrapped and published.
4. The `wallet_escrow_plan` preview keeps the Ledger warning "this judge cannot use a Ledger for announced work" when this wallet is its own judge with a key file; `wallet_escrow` already leaves it out in that case.

## Required

- `wallet_attest`, `wallet_attest_split` and the committee release tool release a proof escrow that takes claims: they pass its claims board, and the stake account when a claim holds, as `intent-engine judge` does through the client. While another worker's claim holds, the preview refuses a payee other than that worker before anything is sent, naming the worker and when the claim ends. A release that pays the claiming worker returns its stake as the program does.
- `wallet_escrow` and `wallet_escrow_plan` take optional `claim_stake` (whole SOL) and `claim_secs` inputs, both or neither, that open claims on each escrow in the same send, with a preview line saying a worker can hold the job for up to that many seconds by staking that amount. `solive_get_claims` then reports `takes_claims: true`. The warning that names `intent-engine claims open` names these inputs instead.
- The plan preview labels every line that describes only the first piece, or replaces them with lines that cover all pieces.
- The plan preview leaves out the Ledger warning under the same rule as `wallet_escrow`.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, and `packages/client` where a release needs a shared helper, plus the generated references and docs the tests check. No program change.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A LiteSVM test opens claims on a proof escrow, takes a claim as a worker, releases it with `wallet_attest` to that worker, and checks the payment and the returned stake. The same test or another shows a release to a different payee refused before sending while the claim holds.
3. A test fails when the judge removes the claims board from the release `wallet_attest` builds.
4. A test shows `wallet_escrow` with `claim_stake` and `claim_secs` leaving an escrow that `solive_get_claims` reports as taking claims.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
