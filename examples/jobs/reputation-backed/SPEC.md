# Job: count reputation by the fees it paid

`reputationOf` counts paid, arm's-length releases. A farmed release costs its farmer almost nothing, so the count is cheap to inflate (threat-model row T-70). The protocol fee of each release goes to the config's fee recipient, a wallet the worker does not control, so it is a real cost behind each release.

## Build

- For each release `reputationOf` already counts (paid, not self-dealt, not funded by the worker), read the protocol fee from its release event (`IntentAttested.fee`, `IntentSplit.fee`) and the create fee from its `IntentCreated` event.
- Credit the worker `fee × share`, where `share` is 1 for a single payee and the worker's split weight for a split, so splitting over many wallets credits no more in total.
- The record gains `backed`, the credited fees summed per mint, and `backed_sol`, the credited fees of releases paid in native SOL plus their create fees, in whole SOL. A fee paid in any other token never counts toward `backed_sol`.
- `intent-engine reputation` and `solive_get_reputation` show both. Existing fields stay as they are.
- A release whose events cannot be read leaves `complete` false and adds nothing to `backed`.

## Rules

- Read nothing beyond the transactions the reader already fetches.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/reputation.md` in at most three sentences, the T-70 row's evidence in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a single-payee release paid in SOL, a split credited by weight, a release paid in another token counted in `backed` but not `backed_sol`, a zero protocol fee crediting nothing, a self-dealt release crediting nothing, and the same values in the command and the tool.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
