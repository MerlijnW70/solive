# Job: Reclaim says why it keeps announcements, and a Ledger swap sends what the tool told it to

Two loose ends in packages/cli from the H14 fixes:

- **Reclaim reasons.** Since commit 1e18933, `client.reclaim` keeps an announcement that can still refute a paid release and returns `reasons: { announcement, reason }[]` beside `kept`. The CLI and MCP reclaim outputs still show only `kept`, so a worker sees that an announcement was kept but not why, or when it can be reclaimed.
- **Ledger swap preview.** On a Ledger wallet, a `wallet_swap` preview made without `start_receive`, then sent with the `start_receive` the preview tells the agent to pass back (as the tool's description and next-hint say), is refused with `DeviceUnpreviewed`: the kept preview is looked up by the exact call arguments (packages/cli/src/agent/wallet/guard.ts), and the send adds `start_receive`. Following the tool's own instructions on a Ledger never works.

## Required

1. Every CLI command and MCP tool that reclaims announcements shows, for each kept announcement, the reason the client gives, in the same plain words the other outputs use; tool descriptions and next-hints stay accurate, and the generated references are regenerated if they change.
2. On a Ledger wallet, a swap or recurring send that follows its preview's instructions (the same arguments plus what the preview told the agent to pass back, including the preview's `approval`) finds the kept preview and is signed when the transaction is the one the preview showed. A send whose transaction differs from the previewed one is still refused, and an expired preview is still refused.
3. Tests for each change, including a Ledger swap previewed without `start_receive` and sent with it, a Ledger send with a changed amount still refused, and the reclaim output naming a kept refuter with its reason.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only packages/cli, its tests, docs and generated references. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test fails when the judge makes the Ledger lookup require the exact call arguments again.
3. A test fails when the judge drops the reasons from the MCP reclaim output.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
