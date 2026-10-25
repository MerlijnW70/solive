# Job: Skip announcements forged under a recipient's wallet slot

Hunt round H12 found that a third party can stall any proof escrow whose judge has no profile encryption key. It announces first with a normal v4 blob sealed to its own wallet. The program accepts it: for a key judge without a profile key it checks only that the blob has one slot with mask 0, not that the slot's fingerprint is the judge's. `firstOpening` and `openings` then see a blob that does not open with the judge's key and does not list the judge's fingerprint, refuse with `key-not-given`, and report the slot as the judge's own wallet. The judge can never give that key, so every honest delivery after it is unreachable until the escrow expires. Committees have the same gap for wallet slots.

The hunter's test that shows it is in the hunt bounty's paid patch (C:\Users\gamin\AppData\Local\Temp\claude\F--solive\8fa2cd32-286a-4f89-8d8c-35201babc7df\scratchpad\hunt12\dc-b\high.patch, file packages/client/test/hunt/dc-forged-wallet-slot.test.ts).

## Required

1. A wallet slot whose fingerprint is not the fingerprint of the wallet-derived key of the recipient the program assigns to it (the judge for a key judge; the member at that position for a committee) cannot be opened by that recipient, and cannot substantiate a refutation under a revealed key, because the recipient check of `openWithEsk` fails. It is therefore not a delivery: `firstOpening`, `openings` and the simple layer skip it and list it in `skipped` with its own reason, for key judges and committee members alike.
2. On a committee escrow, a blob whose recipient count is not the committee's member count is not a delivery either (the hunt also showed one announced through the plain-judge path while the escrow named a committee that did not exist yet): it is skipped and listed with its own reason.
3. A profile slot whose fingerprint is not the recipient's current profile key keeps today's behaviour (`key-not-given`, naming the slot), since that is a key the recipient may still hold after a rotation.
4. The CLI and MCP judge outputs show the new skip reason in plain words with the other skipped announcements.
5. docs/sdk-client.md states the rule in the bullet about skipped announcements, pinned by a test like the page's other sentences.
6. The hunter's test file is added unchanged and passes.
7. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines. Update the API reports with the repository's script if a public type changes.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. packages/client/test/hunt/dc-forged-wallet-slot.test.ts is present, identical to the hunter's, and passes.
3. A test fails when the judge removes the new skip, and a test still shows `key-not-given` for a blob sealed to a recipient's previous profile key.
4. A committee test shows a member skipping a forged wallet slot at its own position, and a blob with the wrong recipient count, and voting for the honest worker.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
