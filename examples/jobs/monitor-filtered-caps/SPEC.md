# Job: The monitor reads only mint cap accounts

To compare mint cap limits with its baseline, the monitor (`packages/cli/src/monitor-limits.ts`) calls `Transport.engineAccounts()`, which sends `getProgramAccounts` for the whole program with no filter (`packages/client/src/rpc-transport.ts`). On a busy cluster that downloads every intent, user state and board on every poll, and many RPC providers refuse unfiltered program scans.

## Required

- `engineAccounts` accepts optional filters (the account discriminator, and the data size where it is fixed) and passes them to `getProgramAccounts`. Calls without filters behave as today.
- The monitor asks only for mint cap accounts.
- The LiteSVM test transport applies the same filters, so tests see what a real node would return.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/client` and `packages/cli`, their tests and test helpers.
- Keep public exports; the new parameter is optional. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A test shows the monitor's request carries the mint cap filter and that other engine accounts are not returned.
3. The judge runs the built monitor with the hosted workflow's arguments against devnet and the committed baseline, and it exits 0.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
