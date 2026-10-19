# Job: let a worker wait for its pay

After `solive_wallet_deliver`, a worker learns it was paid only by calling `solive_wallet_receipt` again and again. Blind agents on devnet did exactly that.

## Build

- `solive_wallet_receipt` and `solive_get_receipt` take an optional `wait`, in seconds, at most the `WAIT_MAX` that `solive_wallet_wait` uses. With `wait`, the tool reads again until the escrow is released or the time is up, then returns the same output it returns today.
- Without `wait`, the tools behave exactly as today.
- When the time runs out unreleased, `next` says so and that calling again with `wait` keeps waiting.
- The `next` hint that `solive_wallet_deliver` returns mentions `wait`.

## Rules

- Reuse the polling and clock that `solive_wallet_wait` uses in `packages/cli/src/agent/wallet/wait.ts`; tests use its fake clock and never sleep for real.
- Tool descriptions stay short: add at most one sentence to each.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: released before the first read, released during the wait, still unreleased when the wait ends, `wait` above the maximum refused, and both tools unchanged without `wait`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
