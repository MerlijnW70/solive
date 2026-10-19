# Job: a Ledger signs only what it can show, and second-node fixes (T-55, T-57, T-45)

Reviews of the Ledger and second-node work found: a judge on a Ledger blind-signs the whole release transaction, so a compromised host can append an instruction (such as a transfer from the Ledger wallet) after the operator checked the message digest; MCP attest and committee previews show an `approval` the device never shows; a saved `confirm-url` breaks `judge digest`; the same node counts as a second node; a saved confirm-url cannot be skipped for one run; and the solver float has no revoke.

## Build

1. **The Ledger signs only the message.** For single-judge releases and committee votes, the Ledger signs only the off-chain message envelope (which the operator can check with `judge digest`); the release transaction is signed and paid by a separate fee-payer key (`--fee-payer <file>`, and the matching MCP setting), never by the Ledger. A judge using a Ledger without a fee-payer key is refused with a message naming the option. Tests show a host that appends an instruction to the release cannot get the Ledger to sign it.
2. **Comparable previews.** Every preview that a Ledger will sign shows exactly what the device shows: the message digest for envelopes, and the message hash (as the multisig tool prints it) for any transaction the MCP wallet signs on a Ledger.
3. **Second node.** A saved `confirm-url` is applied only to commands that accept it (as the saved keypair is), so `judge digest` and others work; a confirm url that resolves to the same endpoint as `--url` is refused; `--no-confirm-url` skips the saved value for one run; `setup --confirm-url` checks the url is reachable and on the same cluster before saving.
4. **Float.** `solver float revoke --keypair <owner> --mint <mint> [--yes]` revokes the delegate; fills on intents whose owner or receiver is the inventory owner are skipped with a reason instead of failing in simulation.

## Rules

- A Ledger path never falls back to a key file, and the fee-payer key is never used for the judge's message.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/judge.md`, `docs/solver.md`, the T-45, T-55 and T-57 rows, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show each numbered item above, including that the mock Ledger is never asked to sign a transaction in the judge and committee-vote paths.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
