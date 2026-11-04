# Job: The issue faucet, demo worker and runbooks do what the docs say (F6)

The deep audit (A4 F10, F11, F12, F18, F21, F22) found gaps between the issue faucet's workflow and its script, an unreachable cap, an undocumented demo worker, and wrong counts in the docs.

## Build

1. **Runbook schedule.** `docs/maintainers/operations.md` says the issue faucet runs several times between monitor checks, but the crons say once. Make the text match the workflow schedules.
2. **One way to find requests.** `.github/workflows/faucet.yml` counts requests by a phrase search, while `scripts/faucet.sh` handles only an exact title. Use one rule in both, and test it.
3. **Parked requests.** A request parked by `later` is picked up again on the next run (`scripts/faucet.sh`). Keep it parked until its stated time.
4. **Daily cap.** The issue faucet's daily cap of 50 cannot be reached with the weekly top-up of 10 SOL. Make the cap, the amount and the top-up agree, and state the arithmetic in the runbook.
5. **Demo worker.** The demo worker's environment variables are undocumented, and NaN intervals are not rejected (`scripts/demo-worker.mts`). Document each variable in the runbook, and refuse an invalid value at startup.
6. **Tool counts.** `docs/reference/mcp-tools.md` says 26 tools and 31 wallet tools while listing more. Generate the counts from the served lists so they cannot drift.

## Tests

Each item has a test that fails without its fix:
- The workflow and the script select the same requests from a fixture set.
- A parked request is skipped until its time.
- The demo worker refuses a NaN interval.
- The generated tool counts equal the lengths of the served lists.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only these files, plus their tests and the generated references:
  - `docs/maintainers/operations.md`
  - `.github/workflows/faucet.yml`
  - `scripts/faucet.sh`
  - `scripts/faucet-topup.sh`
  - `scripts/demo-worker.mts`
  - the generator of `docs/reference/mcp-tools.md`
- No program change. Do not touch secrets or the faucet wallets.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
