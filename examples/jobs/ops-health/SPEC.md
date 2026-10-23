# Job: Alert before the filler or the faucet lets a new user down

A new user's first minutes depend on two services: the devnet filler, which fills the quickstart's swaps, and the devnet faucet, which sends SOL when the airdrop is refused. Both run unattended, and nothing alerts when either stops working.

1. The filler runs as the `solive-filler` systemd service from the main checkout: the unit's working directory is the repository and it runs `scripts/filler.sh` from there, so an edit to the script in the checkout reaches the live filler on its next restart. Its CLI is installed by `scripts/filler-install.sh`, and nothing tells the operator when that install is older than the published release.
2. The hosted monitor checks the program, its config and fill sizes, but not whether swaps are being filled: if the filler stops, quickstart swaps stay open and nobody is told.
3. The faucet refuses requests once its wallet runs low, but nothing warns before that, and nothing refills it.

## Required

- `intent-engine monitor` takes a repeatable option that alerts when a wallet's SOL balance falls below a given amount, naming the wallet and both amounts.
- `intent-engine monitor` takes an option that alerts when a swap the devnet filler would fill, selling SOL for TEST at or above the filler's price and within its size limits, has been open longer than a given number of seconds, naming the intent and how long it has waited. It reads only the chain.
- The hosted monitor workflow uses both: the filler's and the faucet's wallets with a floor each, and the open-swap check with a bound longer than the filler's polling interval, each value stated once.
- `scripts/filler-install.sh` also installs the filler script next to the CLI it installs, the service runs that copy rather than the checkout's, and the install prints the installed CLI's version beside the published one. `docs/maintainers/operations.md` gives the unit and the steps to upgrade.
- A new script tops the faucet wallet up from a funding wallet to a target amount when it holds less than a floor, refusing anything but devnet, previewing without `--yes`, and printing what it sent. `docs/maintainers/operations.md` gives a systemd timer that runs it weekly.
- Tests for each change; every changed text follows the repository's text rules.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, `scripts`, `.github/workflows/monitor.yml`, `monitoring` and `docs/maintainers/operations.md`, plus the generated references the tests check. No program change, no change to the faucet workflow or its secrets, and tests never contact devnet or GitHub.
- Keep existing commands, options and monitor alerts working. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test shows the balance alert firing below the floor and not above it.
3. A test shows the open-swap alert for a fillable swap older than the bound, and none for one the filler would not fill or one younger than the bound; it fails when the judge removes the age check.
4. A test shows the top-up script refusing a cluster other than devnet and sending nothing without `--yes`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
