# Job: Show who announced first, and say what input was wrong

In a devnet job chain on 0.1.46, two workers announced the same work. `wallet_check_delivery` listed the later announcement first, with no slot or time, so the judge first paid the wrong worker and was refused with `NotEarliestAnnouncer`, and the other worker concluded the earliest-announcer rule had been broken. The command line `deliveries` already shows each announcement's `slot`. These gaps came up as well.

1. Wallet tools that refuse input return the text `InvalidInput: fix the listed fields and call again`, but the field list exists only in the structured content, so an agent that reads the text cannot tell which field is wrong: for example `intent` passed to `wallet_attest`, which takes `owner` and `nonce`.
2. `wallet_check_delivery` has no way to wait for a new announcement, so a judge polls in its own loop; `wallet_receipt` and `find_jobs` can wait.
3. `wallet_receipt` with wait returned `RateLimited: the RPC node is rate limiting; wait a few seconds and call again` to the caller instead of waiting through it.
4. `intent-engine judge` on the public devnet node failed at once with `HTTP error (429): Too Many Requests`, and the same command passed when run again shortly after.

## Required

- `wallet_check_delivery` lists announcements earliest first, in the order a release uses to pick the earliest announcer, and gives each its `slot` and, when known, its block time. Its description says the list is earliest first.
- `wallet_check_delivery` takes an optional wait, in seconds within the bounds other waiting tools use, that returns as soon as an announcement newer than the ones already known lands, or when the time is up.
- The text of every `InvalidInput` refusal names each listed field and its message, within the tool text rules; the structured content stays as it is.
- Waiting tools keep waiting through rate limiting until their time is up, and the call that failed in item 4 retries rate limiting as other reads already do.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and `packages/client`, plus the generated references and docs the tests check. No program change. Do not change `wallet_attest`, `wallet_attest_split`, the committee tools, `wallet_escrow` or `wallet_escrow_plan`.
- Keep tool names and existing inputs as they are; add output fields only where a requirement asks for one. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test with two announcements of the same work, the later one returned first by the node, shows `wallet_check_delivery` listing the earlier one first with both slots; it fails when the judge removes the sort.
3. A test shows the `InvalidInput` text naming a wrong field.
4. A test shows a waiting tool returning a result after the node rate-limits it once.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
