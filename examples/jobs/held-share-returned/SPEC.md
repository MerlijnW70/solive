# Job: The SDK says when a held share went back to the owner

Round H16 found the SDK contradicting itself. A held split share that its co-author never claims goes back to the escrow's owner when anyone closes the escrow a year after it expired (`close_intent`, `HELD_CLAIM_SECS`). `client.heldShares` and `plan.claimHeld` already say so. Receipts and `client.reputation(...).held` still say the share is paid to the co-author and waiting for its claim, because `heldPayouts` in packages/client/src/release-holds.ts treats a closed escrow with the announcement's held bit still set as "not yet received". `examples/jobs/held-share-returned/case.patch` adds the test that shows this. It fails on `main` today.

## Required

1. A held share has three states in every read: held for its co-author, received by it, or returned to the owner. A share is returned when the escrow closed while the share was still held. The SDK tells this from the chain: the escrow account is gone, the announcement's bit is still set, and the close transaction refunded the vault to the owner. It never guesses from the clock alone.
2. Receipts name a returned share as returned to the owner, with the amount and the close transaction. Reputation's `held` and the work records never list it as waiting. `earned` and credit do not count it for the co-author, and the owner's records count it as refunded. The docs that describe what `earned` counts say so.
3. The CLI and the MCP tools that show receipts, history and reputation show the returned state in their short text, and their tool descriptions stay accurate.
4. Tests with the test world:
   - the case, turned into a regular test outside `test/hunt/`;
   - a share claimed before the close (received);
   - a share returned after the close;
   - a split with one share claimed and one returned;
   - the owner's view of the refund.
5. Update docs/sdk-client.md and the guide that explains held shares.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 4 pass.
3. A test fails when the judge makes `heldPayouts` treat a closed escrow with the bit set as held again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
