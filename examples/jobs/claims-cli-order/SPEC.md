# Job: The human claims commands use the one claim rule (F7)

The review of E2 found that the human CLI `claims take`, `claims standby` and `claims advance` (`packages/cli/src/claim-commands.ts`) still use their own checks in the old order. They check `ClaimHeld` before `LineWaiting`, the board before the escrow, and the stale view state instead of the chain clock. The MCP tools now use core `takeUntil`, `standByRefusal` and `checkAdvance`.

## Build

1. **One rule.** Route `claims take`, `claims standby` and `claims advance` through the same core checks and the same order as the MCP tools: escrow open, then fills, then the invite or list gate, then the board checks, decided on the chain clock.
2. **Boundaries.**
   - The `standByRefusal` check `secs > maxSecs` (`packages/core/src/claims.ts`) has no test at secs equal to the maximum. Add that boundary.
   - Test that the invite or list gate runs after the escrow and fills checks, in `standbyStep` (`agent/claim-line.ts`) and `takeStep` (`agent/work-claims.ts`).
3. **Guide text.** The claim stake text in `docs/judge.md` quotes a fixed mainnet minimum as the rule. Say the stake is 0 or at least the cluster's rent-exempt minimum of an empty account, as the reference docs now say.

## Tests

Each item has a test that fails without its fix:
- The CLI and MCP give the same refusal for: a held job with a waiter; a closed escrow; a lapsed own claim behind a line; out-of-range secs.
- Secs equal to the maximum is accepted.
- The gate order is pinned for both steps.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/claim-commands.ts`, `packages/cli/src/agent/claim-line.ts` and `packages/cli/src/agent/work-claims.ts` (tests only for the last two), `packages/core/src/claims.ts` (tests only), `docs/judge.md`, their tests and the generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
