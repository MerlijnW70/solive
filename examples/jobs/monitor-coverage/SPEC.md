# Job: A monitor that sees every fill and every admin change

The hosted monitor (`.github/workflows/monitor.yml`) runs `monitor --once` every hour. Three gaps:

1. With `--once`, fill alerts only look at transactions newer than `now - interval`, and the interval defaults to the watch interval, so an hourly run sees a sliver of the hour. No `--max-fill` is passed, so there are no fill-size alerts at all.
2. `CONFIG_FIELDS` (`packages/cli/src/monitor.ts`) leaves out the committee floors (`floor_mints`, `floor_amounts` in the program's config). The admin can lower or clear a floor without an alert.
3. Mint-cap limits are only checked as outstanding against limit. A raised or removed limit is never compared with the baseline.

## Required

- `--once` takes the look-back window from a new `--since <seconds>` flag, defaulting to the interval as today. The hosted workflow passes `--since 3900` so consecutive hourly runs overlap, plus `--max-fill` for wrapped SOL at 10 SOL in raw units.
- The baseline written by `--write-baseline` holds the committee floors and every mint cap's limits (cap, window, window cap, as the program stores them). A change to any of them alerts, naming the field, the mint and both values.
- `monitoring/devnet.json` is regenerated from devnet with the new fields, and the cli tests that pin the baseline shape are updated.
- `docs/maintainers/operations.md`: fix the schedule it states, describe the new fields and `--since`, and add a short "Incident" section: who raises the pause, the exact `raise-pause` command, how the pause is lowered through the multisig, and how the baseline is rewritten afterwards.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only the monitor sources and tests in `packages/cli`, `.github/workflows/monitor.yml`, `monitoring/devnet.json`, the generated references the tests check, and the monitor and incident parts of `docs/maintainers/operations.md`.
- No program change. Keep existing flags and alert kinds; new ones are additions.
- Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests: a fill older than the interval but inside `--since` alerts; a fill above `--max-fill` alerts; changing a floor or a mint cap limit in a LiteSVM world alerts against a baseline written before the change; an unchanged world stays quiet.
3. The judge runs the built monitor with the patched workflow's arguments against devnet and the new baseline, and it exits 0.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
