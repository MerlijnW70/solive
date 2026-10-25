# Job: Fix the judge watch, committee release preview and co-author standing found in hunt H12

Hunt round H12 found three defects off the program. Each hunter's test is in its paid patch; add each test file unchanged and make it pass.

1. `judge --watch` (packages/cli/src/judge-watch.ts) records a work hash as judged and its announcement as seen before calling `judge`, and treats every refusal as final. A stranger who takes the escrow's claim makes `firstOpening` refuse with `claim-held`; the watch never judges that work again, even after the claim lapses, so an unattended watch never pays. Test: C:\Users\gamin\AppData\Local\Temp\claude\F--solive\8fa2cd32-286a-4f89-8d8c-35201babc7df\scratchpad\hunt12\dx\high.patch (packages/cli/test/hunt/dx-watch-claim-lapse.test.ts).
2. The MCP tool `wallet_committee_release` (packages/cli/src/agent/wallet/committee.ts) sends a setup transaction (token accounts, rent from the caller) on `send: true` that its preview never showed. Test: C:\Users\gamin\AppData\Local\Temp\claude\F--solive\8fa2cd32-286a-4f89-8d8c-35201babc7df\scratchpad\hunt12\dx\medium.patch (packages/cli/test/hunt/dx-committee-release-setup.test.ts).
3. Worker standing (packages/client/src/work-records.ts) reads refutations only for the announcer of a release, so the co-author of a split release keeps a clean paid record after a substantiated refutation shows the release paid a later copy; on chain every split recipient is a payee of the refuted release. Test: C:\Users\gamin\AppData\Local\Temp\claude\F--solive\8fa2cd32-286a-4f89-8d8c-35201babc7df\scratchpad\hunt12\dc-a\high.patch (packages/client/test/hunt/dc-refuted-coauthor.test.ts).

## Required

1. The watch tells a refusal that can change (a held claim, an incomplete list, a key not given, an RPC failure) from a final verdict (a failed check), retries the first on later rounds, and still pays each escrow at most once.
2. `wallet_committee_release` previews every transaction it will send, including setup and its rent, and its approval binds them, as `wallet_attest_split` does.
3. A substantiated refutation of a split release counts against every payee of that release, announcer and co-authors alike, in reputation, trust and receipts; an unsubstantiated one counts against none.
4. The three hunter test files are added unchanged and pass.
5. Tests for each change; docs that describe these behaviours say what they now do.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines. Update the API reports with the repository's script if a public type changes.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The three hunter test files are present, identical to the hunters', and pass.
3. A test fails when the judge makes the watch treat a held claim as final again, and one when the judge makes a split co-author's record ignore a substantiated refutation.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
