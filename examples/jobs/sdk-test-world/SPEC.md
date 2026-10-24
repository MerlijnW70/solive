# Job: A test world builders can use

A builder who wants to test an app on `@intent-engine/client` today gets `svmTransport` from `@intent-engine/client/svm` and nothing else: no engine program, no config, no mints, no funded wallets, no clock. All of that lives in this repository's own test helpers (packages/client/test/svm.ts and friends), which do not ship. This job ships a test world so a builder's first test is a few lines and behaves like devnet.

Read first: packages/client/src/svm.ts, rpc-transport.ts, transport.ts, packages/client/test/svm.ts and the tests that use it, packages/client/package.json, scripts/pack-test.sh, monitoring/devnet.json (`programHash`), docs/sdk-client.md, and the release workflow in .github/workflows/release.yml.

## Required

1. `@intent-engine/client/testing` exports `createTestWorld(options?)`. It starts LiteSVM with the engine program, initializes the config the way devnet has it (fee schedule and kinds as in monitoring/devnet.json), and returns the svm, a transport, a ready `client`, and helpers: `wallet(sol?)` for a funded signer, `mint(decimals?)` and `tokens(owner, mint, amount)` for SPL tokens, `now()`, and `warp(seconds)` that moves the clock the program reads. Options cover the start time and fee schedule. Nothing in it reaches a network.
2. The engine program ships inside the package, so `createTestWorld` needs no local build and no environment variable. The shipped program is the one deployed on devnet: a test computes its executable hash the way `solana-verify get-executable-hash` does and compares it with `programHash` in monitoring/devnet.json, and fails when they differ. The repository documents how the shipped file is replaced on the next deploy, in docs/maintainers/operations.md beside the upgrade steps.
3. The svm transport implements every method the RPC transport implements, with the same behaviour for what a client can observe: signatures, history, engine account listing with filters, send status, confirmed reads, and the typed errors (`FailedOnChain`, `MaybeSent` where it applies). A parity test fails when the RPC transport gains a method the svm transport lacks; any method that cannot exist on LiteSVM is listed in the test with the reason.
4. packages/client/test/svm.ts and the other repository test helpers that duplicate the world use `createTestWorld` instead, where that does not change what a test proves.
5. docs/sdk-client.md gets a short "Testing" section with one runnable example: create a world, create a proof escrow, announce from a worker, release it through `firstOpening` and `settleProof`, and check the worker's balance. The docs tests run it. On Windows the page says to run it in WSL, as it says for `svmTransport` today.
6. The packed client tarball contains the program and the testing entry point, and `scripts/pack-test.sh` proves a fresh install can import `@intent-engine/client/testing` and run a world.
7. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- `litesvm` stays a peer dependency: importing the client root must not load it, only the `svm` and `testing` entry points do.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The docs example runs in the docs tests against the shipped program with `INTENT_ENGINE_SO` unset.
3. A test fails when the judge replaces the shipped program file with a different build, and the parity test fails when the judge removes one method from the svm transport.
4. `warp` moves the program's clock: a test expires an escrow with it and the engine accepts the expiry.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
