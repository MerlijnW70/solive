# Job: Mirror the on-chain delivery rules in TypeScript

The program is moving delivery announcements on chain (delivery v4). The pure rules live in Rust in `crates/intent-core/src/delivery.rs` and in the `AttestedDelivery` and `AttestedSplitDelivery` preimages in `crates/intent-core/src/sig.rs`, pinned by `crates/intent-core/tests/delivery.rs`. Clients must compute exactly the same bytes and decisions, so `@intent-engine/core` needs a TypeScript mirror that a differential test keeps identical to the Rust.

## Required

- A new module packages/core/src/delivery.ts, exported from the package root, with the same constants and functions as `delivery.rs`: the tags, `BLOB_VERSION`, the blob length constants, `MAX_SEALED_BLOB`, `REFUTE_WINDOW_SECS`, `MAX_SPLIT_RECIPIENTS`, `commitmentPreimage`, `fingerprintPreimage`, `blobHead`, `mayAnnounce`, the announcement state codec, `closable`, `refutes` and `splitHashPreimage`. Same inputs give the same bytes, the same result and the same refusal as the Rust.
- `attestedDeliveryPreimage` and `attestedSplitDeliveryPreimage` next to the existing preimage builders in `packages/core/src/sig.ts`, byte for byte equal to the Rust.
- The seven new core error names (`BlobMalformed`, `AnnouncementState`, `AnnouncementOpen`, `AnnouncementRetained`, `RefuteNotEarlier`, `RefuteSamePayee`, `SplitCountMismatch`) in the TypeScript core error set, raised by the mirrored functions where the Rust raises them.
- Differential pairs on both sides (`crates/intent-core/tests/differential/pairs.rs` and `packages/core/test/differential/pairs.ts`, with generators in `gen.rs`) for every mirrored function and both preimages, so the existing differential test compares them on generated inputs, including malformed blobs and the edges of the refute window.
- Unit tests in a new file packages/core/test/delivery.test.ts with the same vectors as `crates/intent-core/tests/delivery.rs`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or any Rust under `crates/intent-core/src`; only the differential test files on the Rust side change. Keep TypeScript files under about 500 lines.
- packages/core/src/delivery.ts is a new source file: add it to the `sources:` list of your worktree's copy of `packages/core/noha.yaml`, or the commit hook refuses the commit. Say in your report that you did.
- Do not touch `packages/core/src/sealed-delivery.ts`; the sealed format changes in a later job.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, including the Rust differential test.
2. The differential test lists every new pair and passes.
3. A test fails when the judge changes one tag byte in `delivery.ts`, and another fails when the judge swaps two fields in `attestedDeliveryPreimage`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
