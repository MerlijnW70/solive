# Contributing

## Before you start

- Found a vulnerability? Follow [SECURITY.md](SECURITY.md), never a public issue.
- Found a bug? Open an issue with the steps that reproduce it.
- Planning a larger change? Open an issue first to agree on the approach.

## Set up

Install the versions CI uses:

- Rust 1.98.1, from `rust-toolchain.toml`
- Agave (Solana CLI) v4.1.2
- Anchor CLI 1.2.0
- Node.js 22.12 or later and pnpm 10.20.0

```sh
pnpm install
bash scripts/build.sh
```

On Windows, install the toolchain and run every command on this page inside WSL: the build and check scripts are bash, and litesvm, which the TypeScript tests run the program in, ships no Windows binary.

## Rules for changes

- Every behaviour change comes with a test that fails without the change.
- Code has no comments: tests state what the code does. `scripts/comments.sh` enforces this; Anchor's `/// CHECK:` lines are the only exception.
- Rust tests live in `tests/`, never in `src/`. `scripts/bans.sh` enforces this and the program's other bans.
- Do not edit generated files by hand:
  - IDL and TypeScript client: run `bash scripts/build.sh`, then `bash scripts/codegen.sh`.
  - `docs/reference/`: run `DOCS_WRITE=1 pnpm --filter @intent-engine/cli test docs`.
  - `README.md`, `security.rs` and the `LICENSE` files: edit `identity.toml`, then run `bash scripts/identity.sh`.

## Check before you push

```sh
bash scripts/ci.sh
```

This builds the program, fails on any drift in generated files, lints, and runs the Rust and TypeScript test suites. CI also installs the packed npm packages (`scripts/pack-test.sh`), runs the TypeScript tests on the oldest supported Node.js, and runs the dependency audit, a secret scan, the verifiable build, fuzzing and Kani proofs. Maintainers run additional checks before merging.

## Sign your commits

Every commit needs a `Signed-off-by` line. Add it with `git commit -s`. It certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Contributions are licensed under the license of the files they change:

- BUSL-1.1 for `programs/intent_engine` and `crates/intent-core`
- Apache-2.0 for everything else

## Pull requests

- One change per pull request. Say what changes and why, and link the issue.
- CI must pass, including the sign-off check.
