# Job: reputation relative to the reader

A worker's reputation is the same for every reader, so a ring of wallets paying each other can farm it (threat-model row T-70). Trust that flows only from wallets the reader already relies on gives a ring nothing: with restart probability `a`, a set of wallets holding no seed can score at most `(1 − a) / a` times the trust that enters it from outside.

## Build

- `trustOf(transport, reader, worker, options)` in `@intent-engine/client` computes the reader-rooted personalized PageRank of `worker`, restart probability 0.15, by forward push, seeded with the reader and any extra seeds the caller names. No seed is ever added by default.
- Edges run payer → worker for every release the reputation reader counts (paid, not self-dealt, not funded by the worker), weighted by the fee credit `reputationOf` gives that release (`backed`), each payer's weight split over the distinct workers it paid.
- Exploration is limited to two hops from the seeds and a bounded number of wallets; reaching a limit or failing a read sets `complete` false.
- The result holds the score, `complete`, and up to three seed → worker paths that carry the most trust.
- `intent-engine reputation --worker <w> --reader <r> [--seed <wallet>]...` and a `reader` (plus optional `seeds`) input on `solive_get_reputation` show it beside the existing record. Without a reader, both behave exactly as today.

## Rules

- Never ship default seeds and never seed with a judge.
- Reuse the reputation reader's release reads and filters; do not reimplement them.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/reputation.md` in at most four sentences, the T-70 row's evidence in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a ring of wallets paying each other, funded from outside the reader's graph, scores 0; a worker paid by a wallet the reader paid scores above 0; one bribed edge into a ring leaves the ring's total score at most `(1 − a) / a` times the trust on that edge; a reader with no paid releases and no seeds gets 0 with a clear reason; a limit reached sets `complete` false; and the command and the tool agree.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
