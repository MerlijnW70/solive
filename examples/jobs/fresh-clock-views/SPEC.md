# Job: Previews and pre-checks decide on the chain clock and check what the program checks (H5)

**Rules:**
1. Every preview line about a claim's state comes from the chain clock read for the decision, never from a stale view.
2. Every tool that funds or prepares a claim checks every program refusal it can know before it spends.
3. Every test helper checks the result of each airdrop and send it makes.

The reviews of F7 and F4 found the gaps below.

**Stale view in previews.** The preview line "Ends: the lapsed claim ... whose stake goes to the owner" comes from a stale `view.state`. It appears in:
- `claims take` and `claims advance` (`packages/cli/src/claim-commands.ts`);
- the MCP steps (`agent/work-claims.ts`, `agent/claim-line.ts`).

`claims list` decides on the same stale view.

**Missing checks.** `wallet_worker` (`agent/wallet/worker.ts`, `claimable`) does not check whether fills are paused or the fill kind is disabled. It funds a worker that cannot claim.

**Unchecked results in test helpers.** About twenty test helpers ignore a failed LiteSVM airdrop, among them:
- `packages/multisig/test/svm.ts`;
- `packages/core/test/e2e-engine.ts`;
- `packages/cli/test/harness-transport.ts`;
- many cli tests.

## Build

1. **Stale previews and checks.** Search for every preview line or pre-check that reads `view.state` or `view.line` after a fresh clock read. Derive each one from `claimSlot(board, now)`. List each one.
2. **Pre-checks before funding.** In `wallet_worker`, refuse before funding when fills are paused or the kind is disabled. Search for other tools that fund or prepare work without these checks.
3. **Test helpers.** Make every test helper fail on a failed airdrop or send. Use one shared helper per package where it fits. List each site.

## Tests

- In a preview taken in the moment a claim lapses, the stake line is shown.
- `wallet_worker` on a fill-paused config is refused, and nothing is sent.
- A failed airdrop in each shared helper throws.
- Each new test fails without its fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only the files named here and the ones the searches find, with their tests. No program change.
- Run only the touched tests plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
