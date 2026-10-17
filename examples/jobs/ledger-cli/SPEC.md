# Job: sign with a Ledger from the command line

Owners can only sign with key files: every `--keypair` reads a JSON key from disk. The multisig tool in `packages/multisig` already signs with a Ledger through `usb://ledger` paths, but `intent-engine` cannot.

## Build

- Move the Ledger signer from `packages/multisig/src/ledger.ts` into `packages/client`, exported from `@intent-engine/client`, with its path forms, errors and transport opener. `packages/multisig` imports it from there and behaves as today. The Ledger libraries become exact-version `optionalDependencies` of `packages/client`; update `supply-chain/` with `bash scripts/supply-chain.sh --write`.
- In `intent-engine`, `--keypair usb://ledger`, `usb://ledger?key=<account>` and `usb://ledger?key=<account>/<change>` sign on the device for the commands that only sign transactions: `create` (every kind), `cancel`, `expire`, `close`, `approve`, `revoke-approval`, `deliver`, `advance-nonce`, `advance-epoch`, `claims take`, `claims drop` and `mandate grant|revoke`.
- Every other command given a Ledger path refuses before reading the chain, naming the command and saying it needs a key file because it also signs messages.
- A missing, locked or app-closed Ledger, and a rejection on the device, give the same messages the multisig tool gives today, and nothing is sent.

## Rules

- A Ledger path never falls back to a key file, and no command prints or stores key material.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the forms in `docs/quickstart.md` or the closest guide in at most three short sentences. Regenerate `docs/reference`. Change only `packages/client`, `packages/multisig`, `packages/cli`, `supply-chain` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests use the mock transport `packages/multisig` tests use, and no device. They cover: a `create` and a `cancel` signed through the mock Ledger reach the transport with the device's signature; each path form picks its derivation; each Ledger error and a device rejection send nothing; a message-signing command refuses a Ledger path; the multisig tool's Ledger tests still pass unchanged.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
