# Job: Types that match what the SDK does

`@intent-engine/client` checks several rules only at runtime that its types could state, and some of its types promise the wrong thing. `Outcome<I>` in packages/client/src/simple-types.ts resolves to `Sent` when `preview` is a plain `boolean`, though the call may return a `Preview`. The docs build intent params with `as const` (docs/sdk-client.md) because no constructor gives them their kind's type. Option combinations the code refuses at runtime still compile. This job makes the types say what the code does, so mistakes fail in the editor instead of on chain.

Read first: packages/client/src/simple-types.ts, simple.ts, simple-*.ts, client-types.ts, client.ts, announce.ts, announce-keys.ts, index.ts, packages/core/src/kinds (the params types and `Kind`), docs/sdk-client.md and docs/sdk.md with the tests that run their code blocks.

## Required

1. Every simple-layer call that takes `preview` returns `Preview` for `preview: true`, `Sent` (or its specific result) for `false` or no `preview`, and the union of both for a `preview` typed `boolean`.
2. Core exports one constructor per intent kind (swap, limit, Dutch auction, attested result) that takes that kind's fields and returns params typed for that kind, usable everywhere the SDK takes params. docs/sdk-client.md and docs/sdk.md build params with them and contain no `as const`.
3. Every runtime check in the client and simple layers that refuses a combination of options (one of several required, mutually exclusive, or required together, such as an artifact or a sha256, a signer that signs messages or explicit secret bytes) is also expressed in the input's type, so the refused combination fails to compile. The runtime check stays. The report lists each check found and the type that now carries it.
4. Every function, method and class exported from the client root has a named, exported return type rather than an anonymous inferred one.
5. Type tests: files checked by the existing typecheck that use `@ts-expect-error` for each refused combination and assert the preview result types; they fail the typecheck if a type is loosened.
6. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- Runtime behaviour does not change; existing runtime tests pass unchanged except where a type now rejects their input at compile time (report each).
- packages/cli and packages/solver keep compiling and passing; adapt them where a stricter type now rejects what they pass, and report each place.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh` and `bash scripts/lint.sh` all pass.
2. The type tests fail the typecheck when the judge makes `Outcome` return `Sent` for a `boolean` preview again, and when the judge widens one of the new one-of input types back to all-optional fields.
3. docs/sdk-client.md and docs/sdk.md contain no `as const`, and their code blocks still run in the docs tests.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
