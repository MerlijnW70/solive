# Job: a version in every account, and a way to close outdated ones

Account layouts changed twice without a version: claim boards grew from 168 to 176 bytes, so boards made by the earlier program no longer load, and intents made before the fee snapshot read a fee of zero from bytes that were a gap. Solive has no users yet, so this is the cheapest moment to add a version to every account.

## Build

- Every account the program owns (config, intent, user, mint cap, committee, claim board, stand-by entry, profile, mandate, and any other) carries a `version: u8` set when it is created to the current version of that account type. Every instruction that loads an account refuses one whose version is not the current one with a new named error, so a future layout change can never be read as the current layout.
- `close_legacy`: anyone may close a program-owned account whose size or discriminator does not match any current account type, or whose version is not current, and the instruction sends all its lamports to the wallet the old layout records as the one that paid for it (its owner, payer or worker field, as the old layout defines). An account whose old layout records no such wallet goes to the config's fee recipient. It never touches an account of a current type and version.
- The account sizes, the IDL, the TS decoders and the layout-preimage tests reflect the new field; the SDK refuses to decode an account with an unknown version with a clear message.
- `intent-engine close-legacy --keypair <payer> --address <account> [--yes]` previews and sends it.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Add a short section on versions and `close_legacy` to `docs/maintainers/operations.md` and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages`, `idl` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: each account type is created with its current version; an account with another version is refused by the instructions that load it; `close_legacy` closes a 168-byte claim board from the earlier layout and pays its recorded owner; it refuses every current account; and lamports are conserved.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
