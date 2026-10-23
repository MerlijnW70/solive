# Job: Find the right work, judge as a team

A review of the wallet tools after three devnet job chains found these gaps.

1. `wallet_profile` and `solive_get_profile` exist but are served only with `--all-tools`, so a worker cannot advertise its skills and a payer cannot read them in the default tool set.
2. `wallet_committee_vote` and `wallet_committee_release` are served only with `--all-tools`, and no wallet tool creates a committee; only `intent-engine committee create` does, so a team cannot judge together through the wallet tools.
3. `find_jobs` filters by attestor, mint and least pay, but not by owner, so workers told to skip some owners filtered by hand and once took the wrong job.
4. `wallet_history` cannot be narrowed to one escrow or a time range, and shows no profit for a job a contractor resold: what its client paid against what it paid out in fees and rent.
5. Previews give expiry only as a UTC time, which a contractor read as already past in its own time zone.
6. The tool list runs to tens of kilobytes, and the server instructions give no short index of which tool does what.

## Required

- `wallet_profile` and `solive_get_profile` are served by default with `--wallet`, and `find_jobs` hints point a worker to publishing a profile when it has none.
- A wallet tool creates a committee of members and a threshold, as `intent-engine committee create` does, previewing first; `wallet_committee_vote` and `wallet_committee_release` are served by default, and their descriptions say how a team judges together.
- `find_jobs` takes an optional `owner` and an optional `exclude_owners` list.
- `wallet_history` takes an optional escrow, or a time range, to narrow what it lists; and an optional list of escrows this wallet paid out from for one job it was paid for, for which it returns what it received, paid out, and spent on fees and rent, and the difference.
- Every preview that gives an expiry also says how long from now.
- The server instructions end with a short index that names each served tool group and its tools in one line each, within the tool text rules.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and `packages/client`, plus the generated references and docs the tests check. No program change. Do not change `wallet_claim`, `solive_get_claims`, the escrow rent lines, `wallet_deliver`, `wallet_check_delivery` or the seal tools.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A LiteSVM test creates a committee with the new tool, escrows work judged by it, and releases it with the members' votes, using default-served tools only.
3. A test shows `find_jobs` with `exclude_owners` leaving out a job, and fails when the judge removes that filter.
4. A test shows `wallet_history` returning one job's profit from its client release and two sub-escrow releases.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
