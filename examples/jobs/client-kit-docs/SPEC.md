# Job: The SDK test kit, LiteSVM transport and IDL validator match the real chain, and the docs match the SDK (F4)

The deep audit (A1 L15, L16, L17, L20, L22, L27) found test helpers that hide failures, a LiteSVM transport that answers differently from RPC, a validator that cannot size two IDL types, and docs that name exports that do not exist.

## Build

1. **Observe hooks.** The observe hooks lose send and confirm events on wrapped transports (`packages/client/src/observe-transport.ts`). Report every send and confirm whatever wraps the transport.
2. **Airdrop failures.** The testing helpers ignore airdrop failures (`packages/client/src/testing.ts`). Throw a typed error when an airdrop fails.
3. **LiteSVM parity.** LiteSVM simulation output differs from the RPC transport (`packages/client/src/svm.ts`). Make the simulate result's shape and fields match what the RPC transport returns for the same transaction, and pin it with a test that runs both shapes through the same reader.
4. **IDL validator.** `validateIxAgainstIdl` (`packages/core/src/validate.ts`) cannot size `string` and `option` arguments. Size them, and refuse a malformed one.
5. **Docs.**
   - `docs/mcp.md` and `docs/sdk-client.md` name `DEFAULT_SPEC_SOURCES`, while the code exports `defaultSpecSources()`. Make the docs and the exports agree.
   - `packages/core/README.md` promises builders that the public entry does not export. Export them or drop the promise.

## Tests

Each item has a test that fails without its fix:
- A wrapped transport still reports send and confirm.
- A failing airdrop in the test kit throws.
- LiteSVM and RPC simulate results read the same.
- An instruction with a `string` and an `option` argument validates, and a truncated one is refused.
- A docs check finds every SDK name the docs cite in the public exports.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only these files, plus their tests and the generated references (the API report changes only where an export is added or renamed):
  - `packages/client/src/observe-transport.ts`
  - `packages/client/src/testing.ts`
  - `packages/client/src/svm.ts`
  - `packages/client/src/spec-sources.ts` (export names only)
  - `packages/core/src/validate.ts`
  - `packages/core/src/index.ts` (exports only)
  - `packages/core/README.md`
  - `docs/mcp.md` (the spec-sources sentence only)
  - `docs/sdk-client.md`
- No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
