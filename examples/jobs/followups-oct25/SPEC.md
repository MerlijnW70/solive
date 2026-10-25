# Job: Close the small follow-ups left by the SDK rounds

Earlier jobs and reviews noted small defects they did not fix. For each item below, first check whether it still holds on the base commit. If it does, fix it at its cause with a test that fails without the fix; if it does not, show the evidence in the report (the test, line or command that proves it).

## Items

1. The CLI's agent wallet `planOf` (packages/cli/src/agent/wallet/delivery.ts) reports every invalid input as the field `url`, even a bad sha256 or a bad secret length. It names the field the SDK's `InvalidInput` names.
2. `client.openings`, `client.firstOpening` and the simple layer's `openings` refuse an escrow nobody has announced to yet (no delivery book) as `incomplete`/`closed`, though an open escrow without a book has no announcements. An open escrow without a book lists as complete and empty: `openings` returns no opening and nothing skipped, `firstOpening` refuses with `nothing-opens`, and an escrow that is no longer open still says `closed`. A judge polling an empty escrow gets a plain "nothing yet".
3. packages/multisig still recognises Ledger errors with `instanceof`; it uses `isSdkError` with the error code like the CLI.
4. CLI signed-terms texts (packages/cli/src/agent/signed-terms.ts and the texts they build) say the spec url shows for relayed creates; check that the relayer path really shows it and make the text true.
5. The CLI's spec reading without an RPC url refuses loopback spec urls even for a local validator; check the behaviour against docs/judge.md and the client's rules and make the CLI follow the client's rule.
6. packages/cli/src/delivery-fetch.ts gates work fetching on the genesis hash; check that the gate matches the client's cluster rules (including the test world's offline transport) and that a test pins it.
7. Tests anywhere in packages/ that resolve real DNS names: make them hermetic with an injected lookup.
8. The svm transport decodes intent accounts without checking their version, unlike the RPC transport; make both refuse an unknown version the same way, with a test.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines. Update the API reports with the repository's script if a public type changes.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The report has one row per item: fixed (with the test that fails without the fix) or already gone (with the evidence).
3. A test fails when the judge makes `openings` refuse an open escrow with no delivery book again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
