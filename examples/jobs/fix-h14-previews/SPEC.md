# Job: A wallet swap and an escrow send exactly what their preview showed

Audit round H14 found two MCP wallet tools whose send recomputes what the user approved (packages/cli/src/agent/wallet):

- **PX-2, swap floor** (packages/cli/test/hunt/px-swap-floor-drift.test.ts): `wallet_swap` without `min_receive` previews a floor derived from recent fills (`marketFloor` in trade.ts). On send the floor is derived again from the fills of that moment, with no binding to the preview, so fills staged between preview and send (or ordinary market movement) make the signed Dutch order fall far below the floor the user approved. `wallet_recurring` shares the path.
- **PX-2, claim list** (packages/cli/test/hunt/px-claim-list-swap.test.ts): `wallet_escrow` with claim limits on a sealed spec previews "claims to the 1 wallet …", but the send fetches `spec_url` again and `claimantsOf` (escrow-claims.ts) builds the on-chain claim list from whatever the spec is sealed to then, so a re-sealed spec reserves the job for a wallet the preview never listed.

## Required

1. The send of `wallet_swap` and `wallet_recurring` uses the floor and start the preview showed, never a floor derived again at send. If the market at send time would need a different floor, the tool refuses and asks for a new preview; it never signs below the previewed floor.
2. The send of `wallet_escrow` and `wallet_escrow_plan` uses the claim list, spec hash, spec url and every other term the preview showed. If the spec fetched at send differs in any way that changes what is signed (recipients, claimants, hash), the tool refuses and asks for a new preview.
3. Both bindings use the approval mechanism the other wallet tools already use (an approval code hashing the shown terms, as attest, feedback and committee release do), so a send with changed terms cannot carry the old approval. Tool descriptions and next-hints say what the user resends.
4. The two hunt tests are added unchanged from their deliveries (they are in the H14 kit) and pass with the patch, as do the existing tests.
5. Tests for each change, including a send after ordinary market movement and a send after a spec re-seal.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only packages/cli (agent/wallet and the tool descriptions), its tests and docs, and generated references. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The two hunt tests pass.
3. A test fails when the judge makes the swap send derive its floor from current fills again.
4. A test fails when the judge makes the escrow send rebuild its claim list from the spec fetched at send.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
