# Job: show what a job pays after fees

`solive_find_jobs` and `intent-engine jobs` list `sells` in raw units with `judge_fee` and `fee_bps` beside it. Agents on devnet had to work out what a worker actually receives.

## Build

- Each job in `solive_find_jobs` and `intent-engine jobs` gains `net_pay`: the whole tokens of its `input_mint` that its release would pay the worker today, after the judge fee and the protocol and partner fees, using the same math as the release (`packages/core/src/fee.ts`).
- A job no release could settle shows `net_pay` `"0"` and `payable` `false`; every other job shows `payable` `true`.
- Existing fields stay as they are.

## Rules

- Read the config and each mint's decimals once per call, not once per job.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a job paying SOL and one paying a token with other decimals, a nonzero partner fee, a job that cannot settle, and the same numbers in the command and the tool.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
