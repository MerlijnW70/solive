# Job: TypeScript reads every account field and event the program writes (F5)

The deep audit (A3-10, A3-17) found that the TypeScript side misses a branch of the program's line rule, never reads `Intent.mandate_serial`, and never names 16 events, so receipts miss `AgentPaid` and `RelayerPaid`.

## Build

1. **Line rule.** `lineIntent` (`packages/core/src/versions.ts`) misses the `ClaimList` branch of Rust `line_intent` (`programs/intent_engine/src/versions.rs`). Mirror the Rust function branch for branch, and add a test table shared with the Rust cases.
2. **Mandate serial.** Read `Intent.mandate_serial` in the TypeScript account layout. The solver does not check, before it fills, that an intent's mandate is still live. Check it, and skip a dead one with a reason in its report.
3. **Every event named.** Name every event the program emits in the TypeScript event decoder, so none is unknown. Receipts (`packages/client`) must show `AgentPaid` and `RelayerPaid` payouts.

## Tests

Each item has a test that fails without its fix:
- `lineIntent` agrees with `line_intent` on a `ClaimList` intent.
- A decoded intent carries `mandateSerial`.
- The solver skips an intent whose mandate was revoked, and says why.
- A test lists the program's event names from the IDL and finds each one named in TypeScript.
- A receipt for an agent-created, relayed intent shows the agent and relayer payouts.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only these files, plus their tests and the generated references:
  - `packages/core/src` (layout, versions and events files)
  - `packages/client/src` (receipt and event-reading files)
  - `packages/solver/src` (the fill pre-check only)
- No change under `programs/`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
