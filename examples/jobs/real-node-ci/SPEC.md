# Job: Test the client against a real validator in CI, and stop the LiteSVM memory flake

Two gaps in the TypeScript tests.

1. Nothing in CI talks to a real node. The devnet tests in `packages/cli/test` skip without `DEVNET_RPC`. Confirmation (`packages/client/src/confirmation.ts`), intent notifications (`packages/client/src/intent-notifications.ts`) and the RPC transport (`packages/client/src/rpc-transport.ts`) only meet stubs and LiteSVM. Confirmation decides whether the client resends.
2. TypeScript tests sometimes fail with "Cannot allocate memory (os error 12)" while loading the program into LiteSVM. Every test builds a new LiteSVM (`packages/cli/test/harness.ts`, `packages/client/test/svm.ts`) and nothing frees it.

## Required

- A new script, `validator-test.sh` in the `scripts` folder: it starts `solana-test-validator` on free ports with the built program at its address, waits until it answers, runs one vitest file against it through `createClient`, and stops the validator on every exit path.
- That vitest file: create an intent and confirm it through the real confirmation path, and assert the confirmation reports the landed slot; assert `intentNotifications` delivers the new intent; fill it and confirm; send one transaction with a stale blockhash and assert the client reports it as expired rather than charged. It skips when the validator url is not set, so `ts-test.sh` stays as it is.
- `.github/workflows/ci.yml` runs that new script in the job that already installs agave.
- Stop the memory flake: reuse LiteSVM instances or cap the vitest workers, whichever keeps every test isolated, and show memory stays bounded across many worlds.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only test code, test helpers and vitest config under `packages/client` and `packages/cli`, the new script, and `.github/workflows/ci.yml`. No change to shipped `src` unless the validator test exposes a real bug; then fix it and say so in the report.
- Do not weaken or delete existing tests. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The judge runs the new script in WSL and it passes, and it leaves no validator process behind, also when the test fails.
3. A test or script that builds at least 300 LiteSVM worlds the way the harness does and stays under a stated memory bound, and `bash scripts/ts-test.sh` passes three times in a row on the judge's machine.
4. The report lists any real bug the validator test found.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
