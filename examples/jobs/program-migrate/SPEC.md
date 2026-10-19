# Job: migrate devnet accounts to the current layouts

Devnet runs the program built from the stand-by line commit (`220dde3`; the monitor baseline is pinned in `ea1543d`). Since then, `main` has changed account layouts: fee snapshot, outstanding caps, the committee floor (config 216 to 536 bytes), and account versions (`826c27f`). Upgrading devnet in place would break every config read. It could also leave accounts that no instruction can load, including accounts whose owner needs a refund. This job makes the upgrade safe.

## Build

1. **Map the layouts.** For every account type, compare the `220dde3` layout with `main`: size, field offsets and version byte. Record the result as a table in `docs/maintainers` and as a Rust test that pins both layouts.
2. **Snapshot devnet.** A new script in `scripts` saves every account the devnet program owns (address, lamports, base64 data) to a JSON fixture under `tests/svm`. The fixture is committed; the tests never touch the network.
3. **`migrate` instruction.** It rewrites one account from the `220dde3` layout (or the version-1 layout of `main`) into the current layout in place:
   - Every existing value is preserved, including a user state's epoch and nonce bitmap, intent terms and amounts, held stakes, and caps' outstanding totals.
   - New fields get the values that keep behaviour unchanged: zero where zero means off. An open intent's fee snapshot equals what it was charged at creation, or zero if that can't be known; document which.
   - The account grows if needed, with a payer funding the extra rent. Lamports never leave the account.
   - Anyone may migrate any account, except the config, which only the admin may migrate.
   - It refuses an account that is already current, and an account of an unknown layout.
   - Accounts no type can read stay closable with `close_legacy`.
4. **Refunds never depend on migration.** After the upgrade, an owner can cancel, expire or close every devnet intent in the fixture, whether migrated or not, and gets every token back. If that needs migrating first, the owner's cancel path must do it, or cancel must read the old layout.
5. **CLI.** `intent-engine migrate --address <account>` and `intent-engine migrate --all` preview, then migrate every outdated account the program owns, in batches. `--all` skips accounts that are already current, and reports counts per type and anything it could not migrate. The config step builds a multisig proposal when the admin is a Squads vault, as `propose-admin` does.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Zero-copy and Anchor notes are in `docs/maintainers`.
- Solive has no users yet. Do not add compatibility paths beyond what this spec asks.
- Do not deploy or touch devnet state. Reading devnet for the snapshot is allowed.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests load every fixture account into the current program and migrate each one. They show:
   - every refund path returns all tokens and stakes, both before and after migrating;
   - after migrating, create, claim, fill, release, cancel, the stand-by line and profile reads work;
   - the config keeps admin, guardian, fees and pause flags;
   - the lamports of every account are conserved or topped up, never reduced;
   - migrating twice is refused;
   - a non-admin config migrate is refused.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
