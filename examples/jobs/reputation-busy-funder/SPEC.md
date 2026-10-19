# Job: stop calling every faucet-funded payer unknown

`reputationOf` marks a paid release `funded_by_worker` "yes", "no" or "unknown" by following the payer's earliest funder up to two wallets back. On devnet almost every payer was funded by the faucet, whose history is far longer than the read limit, so almost every release comes out "unknown".

## Build

- A funder whose signature history is longer than the pages `reputationOf` reads for funding counts as a busy wallet, not a fresh one: following it stops there, and the release is "no" unless an earlier hop already found the worker.
- A funder whose history could not be read at all (an RPC error, a node without paged history, or a pruned node that starts after its first transaction) still makes the release "unknown".
- "yes" and the totals behave as today.

## Rules

- Do not raise the read limits in `packages/client/src/funding.ts`.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/reputation.md` in at most two sentences and the T-70 row's evidence in `docs/maintainers/threat-model.md`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a payer funded by a busy wallet ("no"), a payer funded by a fresh wallet the worker funded ("yes"), a payer whose funder's history could not be read ("unknown"), and the same marks in the command and the tool.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
