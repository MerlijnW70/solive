# Job: judges, signed-intent owners and the MCP wallet on a Ledger (T-55, T-56, T-57)

Every release carries an Ed25519 instruction over a message the judge signs, and the program already checks that message in the Solana off-chain message format v1 that the Ledger Solana app can sign (`offchain_envelope` in `crates/intent-core/src/sig.rs`). But the Ledger signer in `@intent-engine/client` only signs transactions, `signEd25519Instruction` takes a key-pair signer, and `ledger-keys.ts` refuses a Ledger for every command that signs messages, so judge keys, signed-intent owners and the MCP wallet are files on disk. Background research: `examples/jobs/r-key-custody` and its report (ask the judge for it if needed; the spec is what counts).

## Build

- The client's Ledger signer also signs messages, through the Ledger app's off-chain message signing, and checks each returned signature against the message before using it.
- `signEd25519Instruction` and every caller accept any message signer, so a single-key judge (`judge`, `judge --watch`, `committee release` for a single judge, the release MCP tools) and a signed-intent owner (`signed prepare`) can use `--keypair usb://ledger` and the other Ledger path forms. Remove the refusal in `ledger-keys.ts` for every command whose messages are this single-signer envelope; keep refusing where the envelope's signer field is not the signing key (committee and split cosigning), with the existing message.
- `intent-engine judge digest --owner <address> --nonce <n> --pay-to <wallet> [--result <n>]` prints, from chain data, the digest the Ledger will show for that release, so an operator can compare it on a second machine before approving.
- `intent-engine mcp --wallet` accepts a Ledger path as its wallet: every send waits for the device, and a device refusal comes back as a problem with nothing sent.

## Rules

- A Ledger path never falls back to a key file, and nothing prints or stores key material.
- Reuse the mock transport the multisig Ledger tests use; tests use no device. A test checks that the bytes sent to the mock device for a judge release equal the program's `offchain_envelope` for that release.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/judge.md` (replace the paragraph that says a judge cannot use a Ledger), `docs/ai.md` or `docs/mcp.md` for the wallet, the T-55, T-56 and T-57 rows in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a judge release and a signed intent signed through the mock Ledger verify in LiteSVM; a device rejection and each Ledger error send nothing; committee and split cosigning still refuse a Ledger; `judge digest` prints the digest the release then signs; and the MCP wallet sends only after the mock device signs.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
