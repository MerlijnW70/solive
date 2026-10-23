# Job: A sealed file that binds its recipients and reaches every judge

A review of the invite-only job flow at 0.1.49 found these gaps in sealing. Each has a failing test or a code reference in the review.

1. `wallet_seal_spec`, and `intent-engine seal --to`, given a committee as attestor seal to the committee's account address, a key nobody holds, so no member can read the spec; `wallet_seal_work` already seals to the members. Sealing to any address off the ed25519 curve does not fail.
2. The recipient list is not bound to the sealed data: the content's authenticated data is a constant, so whoever can rewrite the hosted file can add a wallet to `sealed_to`, which the invite check trusts, while the file still opens for the real recipients.
3. A sealed file may list a wallet twice or no wallet at all; `unseal` uses the first entry, so a junk first entry makes the file fail to open for that wallet.
4. Sealing targets only the key derived from each wallet. A Ledger judge or member that publishes an encryption key in its profile cannot open sealed work or a sealed spec: `wallet_fetch_work` and `solive_get_spec` open only with the wallet's key file, and `intent-engine unseal` takes only `--keypair`.
5. `intent-engine seal` writes sealed files larger than the `MAX_SPEC_BYTES` that `solive_get_spec` and `wallet_fetch_work` read, without a warning.
6. Workers saw `wallet_history` list no claim, stake out or stake back for a claim they took on a released job; `wallet_receipt` does not say a claim's stake came back, and labels the paid token account only as `payee`.
7. `intent-engine advance-nonce` sends at once, without the preview and `--yes` that other sending commands use.

## Required

- Sealing to a committee seals to its members, in the seal tools and `intent-engine seal`; sealing to an address off the ed25519 curve that is not a committee is refused.
- The sealed format binds its full recipient list to the sealed data, so a file with a wallet added, removed or reordered does not open; a file with a duplicate wallet, no wallet, or more than the most allowed is refused. Files in the old format are refused with a message saying to seal again. `wallet_seal_spec`, `wallet_seal_work`, `solive_get_spec`, `wallet_fetch_work`, `seal` and `unseal` all use the new format.
- Sealing to a wallet whose profile publishes an encryption key seals to that key, as announcements already do; `solive_get_spec` and `wallet_fetch_work` open with the encryption key files the server was given, and `intent-engine unseal` takes `--encryption-keypair`.
- `intent-engine seal` warns when its output is larger than `solive_get_spec` and `wallet_fetch_work` read.
- `wallet_history` lists every claim this wallet took, dropped or queued with the outcome of its stake, including on released escrows; `wallet_receipt` says when a claim's stake returned to the paid worker and labels `payee` as the token account.
- `intent-engine advance-nonce` previews without `--yes` and sends only with it.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/core`, `packages/cli`, `packages/client` where needed, `docs/private-jobs.md`, and the generated references and docs the tests check. No program change. Do not change the invite check, `wallet_attest`, `wallet_attest_split`, the committee release tools, `wallet_claim`, `wallet_deliver`, `wallet_escrow`, `wallet_escrow_plan` or the fetch helpers.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test seals to a committee and shows each member opening the spec with `solive_get_spec`.
3. A test adds a wallet to a sealed file's list and shows it no longer opens; it fails when the judge removes the list from the authenticated data.
4. A test seals to a wallet with a published encryption key and opens the work with `wallet_fetch_work` given only that key file.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
