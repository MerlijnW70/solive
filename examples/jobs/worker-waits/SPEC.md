# Job: Smoother waiting and checking for workers

Two blind workers in a devnet job chain on 0.1.46 reported these gaps, and the judge hit the last two.

1. Once an escrow is released and closed, `wallet_check_delivery` refuses with `NotFound: no intent …; it was settled and closed, or never made`, while `wallet_receipt` still finds the release. Nothing points the caller there.
2. A worker read `own.earliest: true` from `wallet_check_delivery` while another worker's announcement was listed, and could not tell that it means earliest for the given sha256, not for the escrow.
3. `wallet_receipt` says "call solive_wallet_receipt again with wait to keep waiting" with wait and "no release of this escrow is in its history yet; check again later" without it, for the same state.
4. A worker that delivered to three escrows had to wait on each with its own `wallet_receipt` call, and the parallel waits ran into rate limiting.
5. Every reader retries rate limiting with the same fixed backoff, so parallel callers retry in lockstep and can keep hitting the limit until the retries run out.
6. `intent-engine judge --plain-node` without `--sandbox viper` runs the check without saying that `--plain-node` did nothing.

## Required

- `wallet_check_delivery` on a closed escrow tells the caller to use `wallet_receipt` with the escrow's owner and nonce, instead of a bare `NotFound`.
- The description of `own.earliest` says it is about the given sha256: no earlier announcement of that same work is known.
- `wallet_receipt` gives one `next` text for an unreleased escrow, whether or not it waited, naming `wait` for the caller that did not pass it.
- A worker can wait in one call for the first release among up to 10 escrows, each named by owner and nonce, and learns which one was released and to whom. Existing inputs and outputs keep working as they are.
- The shared rate-limit retry adds random jitter to its backoff, and follows a `Retry-After` header when the node sends one, within the same overall limit.
- `intent-engine judge` refuses `--plain-node` without `--sandbox viper` before running anything, saying it applies only there.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and `packages/client`, plus the generated references and docs the tests check. No program change.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test waits on several escrows and returns the one released, naming it; it fails when the judge makes the wait read only the first escrow.
3. A test shows the retry delay varying between attempts and following `Retry-After`.
4. A test shows `judge --plain-node` without `--sandbox viper` refused before any check runs.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
