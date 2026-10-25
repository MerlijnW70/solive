# Job: Check the layout version on every engine account the packages read

`checkAccountVersion` in packages/core/src/versions.ts refuses engine account data whose size or stored version does not match a layout the SDK knows. Some read paths use it (packages/client/src/job-proofs.ts, announcement-reads.ts, client-committee.ts), but many decode account bytes with a generated decoder directly, for example packages/cli/src/crank.ts, agent/read.ts, agent/settle.ts, solve-commands.ts, monitor-health.ts, judge-watch.ts, agent/wallet/wait.ts and packages/solver/src/inventory.ts. After the next layout change those paths would read an old or newer account as if it had today's layout: wrong amounts, owners or status, with no error.

## Required

1. Core exports one decode function per engine account type (every account in the generated client: intents, configs, claims boards, committees, announcements, delivery books, refutations, user states and any other). Each checks the data with `checkAccountVersion` and then decodes it; it is the only way the packages turn engine account bytes into a typed account.
2. Every place in the src of core, client, solver, cli and multisig that decodes engine account data uses those functions. Decoding instruction data, parameters, extensions or other bytes that are not an account is left as it is.
3. A read of one named account (by address) that finds an unknown layout fails with the existing `AccountVersionError` or `NotAnEngineAccount`. A scan over many accounts (solver intents, crank, monitor, wallet history, treasury and the like) skips such an account instead of failing as a whole, and the result or log names the address and the reason the same way the existing skip reasons do.
4. A test in each package fails when its src decodes engine account bytes with a generated account decoder outside the new functions, so a new raw decode cannot land.
5. Tests for each change, including at least: a named read refusing an intent whose stored version is one above the newest, a solver scan and a crank scan skipping such an intent while handling the valid ones next to it, and a monitor or wallet history read doing the same.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the IDL or the generated client. Keep public exports and names as they are, and add the new ones. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The tests in Required 5 pass.
3. A test fails when the judge replaces the new decode function with a direct generated decoder call in packages/cli/src/crank.ts.
4. A test fails when the judge makes the new intent decode function skip `checkAccountVersion`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
