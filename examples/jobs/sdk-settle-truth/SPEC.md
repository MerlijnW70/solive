# Job: SDK cancel and committee settle preview what is sent (D8)

The deep audit of the client (A1 M3, L6, L13, L37) found these faults.

## Build

1. **Cancel refund is the vault.** `packages/client/src/simple-work.ts` previews `escrowed - filled` as the refund, but the program refunds the whole vault (`cancel_intent.rs`). The CLI was fixed to read the vault balance (`packages/cli/src/crank.ts`, `agent/settle.ts`). Move the vault-balance read into the client and use it from both, so the SDK and the CLI give the same figure.
2. **Duplicate votes.** `client-settle.ts` slices committee votes to the threshold before removing duplicates, so votes `[A, A, B]` at threshold 2 fail although two members voted. Remove duplicates by member first, and refuse with a clear count error when there are too few distinct votes.
3. **Fractional result.** `simple-work.ts` turns a fractional `result` into a raw `RangeError`. Refuse it with `InvalidInput`.
4. **One refusal text.** "Only the owner cancels" is written twice (`client-intents.ts`, `simple-work.ts`); use one.

## Tests

Each item has a test that fails without its fix: a vault topped up from outside previews the vault amount in SDK and CLI alike; `[A, A, B]` at threshold 2 settles; too few distinct votes give the count error; a fractional result gives `InvalidInput`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client` (`simple-work.ts`, `client-settle.ts`, `client-intents.ts`, a new vault file if needed, `internal.ts`), `packages/cli/src/crank.ts`, `agent/settle.ts`, their tests and `api-report.txt` through the repo's script. Do not touch `release-plan.ts`, `agent/wallet/attest.ts` or `split.ts`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
