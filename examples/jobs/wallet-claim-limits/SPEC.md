# Job: Claim stakes respect the wallet's limits (D5)

The deep audit of the CLI (audit A2, findings W1 and C10) found that the MCP claim tool skips checks its siblings make.

## Build

1. **Stakes count against the sell limits.** `wallet_claim` take and standby (`packages/cli/src/agent/work-claims.ts`) stake SOL that is forfeited on a lapse, but never call `checkSale`, so a server started with `--wallet-per-trade` or `--wallet-per-hour` limits can still lock and lose a large stake. `wallet_worker` counts the same stake (`agent/wallet/worker.ts`). Count the stake and the entry rent against the wallet's limits before take and standby, record it in the sale book the same way, and refuse over the limit before anything is sent.
2. **Same pre-checks as the CLI.** CLI `claims take` and `standby` refuse a paused or fill-disabled program before sending (`packages/cli/src/claim-commands.ts`); the MCP tool does not. Use one shared pre-check for both, so they cannot drift.

## Tests

Each item has a test that fails without its fix: with a per-trade SOL limit below the stake, `wallet_claim take` is refused and sends nothing; the sale is recorded after a send; take on a fill-paused config is refused before sending through MCP and CLI alike.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/agent/work-claims.ts`, `agent/claim-line.ts`, `claim-commands.ts`, a shared helper if needed, and their tests. Do not touch `agent/wallet/escrow.ts`, `escrow-terms.ts`, `costs.ts`, `agent/budget.ts` or `monitor.ts`; other jobs change them. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
