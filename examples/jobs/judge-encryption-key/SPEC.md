# Job: a judge encryption key so Ledger judges can open sealed deliveries (T-57, T-38)

Delivery v3 seals each announcement's salt and url to the judge (or each committee member) with X25519 keys derived from their Ed25519 wallet keys (`packages/core/src/sealed-delivery.ts`). A Ledger never reveals that secret, so a judge or committee member on a Ledger refuses every escrow that has announcements. Solive has no users yet, so the profile layout may change.

## Build

- A wallet's on-chain profile can hold an X25519 encryption public key, set and changed by the wallet with `profile set --encryption-key <base58>` (and the profile MCP tool), separate from its signing key.
- Delivery v3 seals to a recipient's profile encryption key when its profile has one, and to the key derived from its wallet otherwise. The worker's announcement records which key each recipient got.
- The judge and committee tools open sealed deliveries with an encryption key file (`--encryption-keypair <file>`, and the matching MCP setting) when given, while signing releases and votes with any signer, including a Ledger. `intent-engine profile encryption-key new --out <file>` creates such a key file and prints its public key.
- Remove the Ledger-judge refusal for escrows with announcements when an encryption key is configured; keep it, with a message naming the setting, when none is.

## Rules

- The encryption key never signs anything and the signing key never needs to be a file.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update `docs/judge.md` (Ledger and committees), `docs/reputation.md` or the profile docs, the T-38 and T-57 rows, and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages`, `idl` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a worker seals to a judge's profile encryption key; a judge signing through the mock Ledger with an encryption key file opens the announcement and is paid out correctly; a committee member on a mock Ledger votes after opening with its encryption key; without a profile key sealing falls back to the wallet-derived key; and a Ledger judge with no encryption key configured gets the refusal naming the setting.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
