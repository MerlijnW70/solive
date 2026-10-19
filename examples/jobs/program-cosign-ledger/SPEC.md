# Job: committee and split cosigners on a Ledger (T-55, T-57)

A committee or split release carries one Ed25519 signature per cosigner over an off-chain message envelope whose signer field holds a fixed tag (`COMMITTEE_COSIGN_TAG`, `SPLIT_COSIGN_TAG`) instead of the cosigners' keys (`programs/intent_engine/src/attested.rs`, `crates/intent-core/src/sig.rs`). The Ledger Solana app signs an off-chain message only when its own key is in the signer list, so committee members and split cosigners cannot use a Ledger. Solive has no users yet, so the message format may change. Background research: `examples/jobs/r-key-custody`.

## Build

- Move the tag into the digest (the digest covers the tag and the preimage), and make the envelope for a cosigned release `prefix ‖ version 1 ‖ n ‖ the cosigners' keys, sorted and deduplicated ‖ hex(digest)`, in the Solana off-chain message v1 format.
- The program checks each cosigner's Ed25519 signature over that one envelope, with each entry's public key read from that key's slot inside the message, and rejects any envelope whose signer list is not exactly the sorted, deduplicated cosigner set.
- The TS core and client build the same envelope, `committee vote`, `committee release` and the split release tools sign it, and the CLI's Ledger refusal for committee and split cosigning is removed, so a cosigner can use `--keypair usb://ledger`.
- Single-judge releases keep their current envelope.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts; keep the golden vectors that pin the envelopes in step. Update the T-55 and T-57 rows, `docs/judge.md` (committees), and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: a committee release and a split release whose cosigners sign the new envelope settle; an envelope with a missing, extra, unsorted or duplicated key is refused; a signature over the old tag-in-signer envelope is refused; and a cosigner signing through the mock Ledger produces a signature the program accepts.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
