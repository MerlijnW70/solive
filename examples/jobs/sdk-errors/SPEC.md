# Job: One typed error model for the SDK

`@intent-engine/core` and `@intent-engine/client` throw about 30 error classes that share no base, plus 40 bare `Error`, `RangeError` and `TypeError` throws in packages/client/src alone. A builder cannot tell an SDK refusal from a bug, cannot switch on an error without matching message text, and cannot tell "this transaction certainly did not land" from "it may have landed": `Charged` carries no signature, and a network error from `sendTransaction` itself escapes raw, which invites a second send that can lock funds twice. This job gives the SDK one error model and makes ambiguous sends safe to handle.

Read first: packages/client/src/rpc-retry.ts, rpc-transport.ts, confirmation.ts, errors.ts, client-errors.ts, announce-errors.ts, accounts.ts, job-specs.ts, ledger.ts, packages/core/src (every `class ... extends`), packages/cli/src/agent/problems.ts, agent/signed-relay.ts, agent/wallet/guard.ts, and the generated docs/reference/errors.md with the test that writes it.

## Required

1. `SdkError extends Error` lives in packages/core and is exported from the roots of core and client. It has `readonly code`, a kebab-case string literal fixed per subclass, `name` equal to the class name, and the standard `cause`. Every error class in packages/core/src and packages/client/src extends it with its own code. `isSdkError(error, code?)` narrows to the class of that code through an exported code-to-class map type, so `switch (error.code)` is exhaustive.
2. No `throw new Error`, `RangeError` or `TypeError` remains in packages/core/src or packages/client/src. Invalid caller input throws `InvalidInput` with `field` and `rule`; every other throw uses a named class. A third-party error is wrapped only where the SDK adds meaning, with the original as `cause`.
3. Sending:
   - `FailedOnChain` carries `signature`, the node's `logs` when it returned them, `program` (the program that failed) and `engine` (the decoded engine error) only when that program is the engine.
   - `MaybeSent` replaces `Charged` for every outcome where the transaction may have landed, including a `sendTransaction` call that fails after the signed bytes may have reached a node (network error, timeout, non-JSON answer). It carries `signature` and `lastValidBlockHeight`.
   - `BlockhashExpired` stays the only outcome that means certainly not landed, and is thrown only when that is proven, as today.
   - `client.status(signature)` returns `confirmed`, `failed` (with the same fields as `FailedOnChain`), `expired` (checked against a given `lastValidBlockHeight`) or `pending`, so a caller resolves `MaybeSent` without resending.
4. `NotSettleable`, `NotDeliverable`, `NotFillable` and `FirstOpeningRefused` carry a machine `reason` union beside their message; every place that throws them names one.
5. The CLI and MCP wallet map SDK errors by `code`, not by `instanceof` chains or message text, and keep their texts unless a test shows the change is better. A `MaybeSent` result tells the user to run the existing `lookup` command with that signature instead of sending again.
6. The generated docs/reference/errors.md lists every SDK error code with its class, fields and meaning, written by the repository's own generator; its test fails when a class is missing from the page.
7. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- Keep exported class names, except `Charged` becomes `MaybeSent`; list every renamed or removed export in the report.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh` and `bash scripts/lint.sh` all pass.
2. A test enumerates every error class exported from core and client: each extends `SdkError`, and no two share a code. A test fails on any bare `throw new Error`, `RangeError` or `TypeError` in packages/core/src or packages/client/src.
3. A LiteSVM test: a transaction whose engine instruction fails surfaces `FailedOnChain` with its signature, logs, `program` and `engine.name`; a transaction failing in another program surfaces `program` set and no `engine`.
4. A fake-transport test: `sendTransaction` throws a network error after the transaction was accepted; the call throws `MaybeSent` with the signature, nothing is sent twice, and `client.status` reports `confirmed` once the fake lands it. A second test shows `expired` for a transaction that never lands past its block height.
5. A test fails when the judge makes a `sendTransaction` network error escape without `MaybeSent`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
