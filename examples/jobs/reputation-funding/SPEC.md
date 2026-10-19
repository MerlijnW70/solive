# Job: flag reputation a worker may have paid for itself

Reputation counts releases from distinct payers and judges, but a second wallet of the same person is not linked to the first (threat-model row T-70). A worker can fund a fresh wallet, post jobs from it, and pay itself.

## Build

- `reputationOf` in `@intent-engine/client` marks each paid release `funded_by_worker` when the earliest transfer of SOL into the payer's wallet that the node can return came from the worker's wallet, or from a wallet the worker funded first in the same way, at most two hops back.
- `solive_get_reputation` and `intent-engine reputation` show that mark per release and a count of such releases, and leave them out of the totals the way self-dealt releases are left out today.
- When the payer's funding history cannot be read in full, the release is marked unknown, never clean.

## Rules

- Bound the extra reads: at most a fixed number of history pages per payer, shared across releases from the same payer.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update the T-70 row's evidence in `docs/maintainers/threat-model.md` with the new tests' names, and regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a payer funded by the worker, one funded through one wallet in between, one funded by a stranger, one whose history is cut short, and the same results in the command and the tool.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
