# Job: Let a new user finish the first paid job alone

A blind first-time user followed `docs/first-job.md` on devnet with the published CLI. Install worked at once, then they were stuck: devnet refused the airdrop and the only way on was the faucet link, a GitHub issue form that needs a browser. After someone sent SOL by hand, the rest of the guide took them a couple of minutes and every promise held. These gaps came up.

1. `intent-engine setup` asks devnet for one fixed amount and gives up when it is refused; devnet often refuses a large request while allowing a smaller one.
2. The only fallback is a browser form. A user with the GitHub CLI signed in could file the same request from the terminal, and nothing waits for the SOL to arrive.
3. With 0.05 SOL, setup said the wallet holds "less than the 0.1 SOL setup counts as enough to start" and pointed to the faucet again, though the guide needs far less; the guide never says how much it needs.
4. The faucet text does not say that a scheduled run answers the request, or roughly when SOL arrives.
5. In the guide, `create` prints a Ledger and encryption key warning a new user cannot act on, the receipt shows `payee` beside `paid_to` without saying why, `deliver`'s output is not described, and the copier cheat is only shown after the job is paid, so the rule that the first announcer is paid is claimed but not shown.

## Required

- `setup` asks devnet for smaller amounts in turn when a request is refused, and says which amount it got.
- `setup` can file the faucet request from the terminal when the GitHub CLI is installed and signed in, behind an explicit option, and can wait for SOL to arrive with a bounded wait, telling the user how long it waits. Without the GitHub CLI it prints the link as today and says the request needs a browser and a GitHub account.
- The amount setup counts as enough to start covers what the first paid job guide needs, and setup does not send a user with that much to the faucet; the guide states how much SOL it needs.
- The faucet text says the request is answered by a scheduled run and when the user can expect SOL, matching the faucet workflow's schedule.
- `docs/first-job.md` shows the copier announcing the same work before the release and the judge paying the worker, says what `deliver` prints, explains `payee` in one line, and tells the user the Ledger warning does not apply to a key file. Its test checks each of these.
- Tests for each change; every changed text follows the repository's tool text rules.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and the docs. No program change, no change to the faucet workflow or its secrets, and never call GitHub from tests.
- Keep existing commands and options working. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test shows setup getting a smaller airdrop after a larger one is refused.
3. A test shows setup with the amount the guide needs not pointing to the faucet; it fails when the judge restores the old threshold.
4. The guide's test shows the copier announcing before the release and the worker being paid.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
