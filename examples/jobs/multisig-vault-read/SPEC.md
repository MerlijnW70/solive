# Job: Read the multisig vault in one call, and refuse unsafe upgrades

`scripts/deploy.sh` and `scripts/idl.sh` call the multisig tool's `show` only to learn the vault. `show` (`packages/multisig/src/show.ts`) reads and reviews every proposal ever made, so public devnet answers 429 and both scripts fail. The vault is a PDA of the multisig and needs no proposal reads.

## Required

- A new `vault --multisig <address> [--url]` command in `packages/multisig` that reads the multisig account once, refuses an address that is not a Squads v4 multisig, and prints JSON with `vault`, `threshold`, `timeLock`, `members` and `transactionIndex`.
- `deploy.sh` and `idl.sh` use `vault` instead of `show`. `idl.sh` builds `packages/core` and `packages/multisig` first, as `deploy.sh` does.
- On mainnet (by genesis hash, as the scripts already check the cluster), `deploy.sh` refuses to upgrade an existing program without `--multisig`, and refuses a multisig with threshold below 2 or time lock 0. Devnet keeps today's behaviour.
- Document `vault` and the new refusals in the deploy part of `docs/maintainers/operations.md`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/multisig`, `scripts/deploy.sh`, `scripts/idl.sh`, their tests, the generated references the tests check, and the deploy part of `docs/maintainers/operations.md`.
- Keep existing commands and output fields. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests: `vault` on a LiteSVM or fixture multisig prints the right vault, threshold, time lock and members, and refuses a non-multisig account; `vault` makes one account read.
3. Tests for the mainnet refusals that run without a network, for example by stubbing the genesis hash and `vault` output.
4. The judge runs `vault` against the devnet multisig `D2DffpdbegJMjTvsvtcQa61D1m5HLQvp5mFwUmeaHC6d` on public devnet and gets the vault `DxF6mApa3rnN7QgdqjtBvgyDesvKhVTYQ14Giike4Urv`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
