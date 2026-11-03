# Job: One claim rule, shared by core, client and CLI (E2)

The deep audit (A1 M9, A1 L23, A3-18, A2 C10 remainder) found that core's claim checks (`checkClaimant`, `checkStandBy`, `checkAdvance` in `packages/core/src/claims.ts`, which mirror the program's `crates/intent-core/src/claim.rs`) have no non-test caller, while the same rules are hand-written again in the CLI and client, and that the minimum claim stake is a fixed constant while the program reads rent live.

## Build

1. **Use the core checks.** The CLI claim paths (`packages/cli/src/agent/work-claims.ts`, `agent/claim-line.ts`) and the client (`packages/client/src/client-claims.ts`) refuse a claim, standby or advance through the core checks, so one rule decides everywhere and the refusal names the program's error.
2. **The stake floor follows rent.** `MIN_CLAIM_STAKE` is fixed at the current rent minimum, while the program uses the cluster's rent for an empty account. Read the floor from the cluster (the client already reads the rent sysvar elsewhere), and use it in the CLI pre-checks and texts (`agent/wallet/escrow-terms.ts`, `agent/problems.ts`).
3. **Error texts match.** Where the program refuses with a claim error, the CLI and MCP refusal names the same case with the same wording source.

## Tests

Each item has a test that fails without its fix: a CLI claim on a cooldown or a waiting line uses the core error; the stake floor follows a rent sysvar with a different rate in LiteSVM; client and CLI give the same refusal for one case.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/core/src/claims.ts`, `packages/client/src/client-claims.ts`, `packages/cli/src/agent/work-claims.ts`, `agent/claim-line.ts`, `agent/wallet/escrow-terms.ts`, `agent/problems.ts`, their tests, `api-report.txt` through the repo's script and generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
