# Job: Remove the v3 sealed delivery format from core

On branch `v4-program` every package delivers through on-chain announcements sealed in the v4 format (packages/core/src/sealed-delivery-v4.ts). The v3 format in packages/core/src/sealed-delivery.ts (delivery and opening memos, the v3 commitment, salt check and fingerprint tags, `sealDelivery`/`openDelivery`, `maxSealedUrl(recipients)`) has no production user left. This job removes it without losing a property its tests protect.

Read first: packages/core/src/sealed-delivery.ts, sealed-delivery-v4.ts, delivery.ts, announce-size.ts, index.ts, and the tests that import v3 names: packages/core/test/sealed-delivery.test.ts, encryption-key.test.ts, key-handling.test.ts, sealed-delivery-v4.test.ts, sealed-v4-reference.ts, sealed-delivery-v4-layout.test.ts, and packages/cli/test/sealed-delivery.test.ts.

## Required

1. Delete every v3-only export of sealed-delivery.ts. Names still used by v4 code or other packages (for example `SALT_TAG`, `saltMessage`, `isSaltHex`, `UNOPENED`, the `SealRecipient` and `DeliveryOpener` types) move to the module where they belong, keep their name and bytes, and stay exported from the package root. `Opening` and `maxSealedUrl` resolve only to their v4 meanings.
2. For each test that exercises v3 code, keep the property if v4 still needs it and test it on v4: encryption keys sealing and opening per recipient, keys recorded at each recipient's position, duplicate wallets, wallet-derived keys when no encryption key is published, refusal of small-order and non-canonical keys, refusal of a tampered header, and keys that can never be exported while sealing or opening. Delete tests of memo framing, v3 salts and checks, and v3 version handling. Name each deleted and each ported test in the report with its v4 replacement.
3. packages/cli/test/sealed-delivery.test.ts tests what the CLI still does (its file and spec sealing) or is folded into the CLI's announcement tests; nothing in it uses v3 delivery code afterwards.
4. Docs and generated references mention no v3 delivery names; regenerate generated files with the repository's own scripts.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- Change bytes of no v4 format, tag or preimage; the differential and golden tests must pass unchanged.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh` and `bash scripts/lint.sh` all pass.
2. No file under packages/*/src imports or defines `sealDelivery`, `openDelivery`, `deliveryMemo`, `parseDeliveryMemo`, `openingMemo`, `parseOpeningMemo`, `saltCheck`, `deliveryCommitment`, `keyFingerprint` (the v3 one) or the v3 tags.
3. A test fails when the judge makes v4 sealing accept a small-order recipient key, and another fails when the judge makes v4 opening create an extractable key.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
