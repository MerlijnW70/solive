# Job: Short, plain texts when a new wallet has no SOL

The first-run walk found two texts that lose a novice (plan item 3).

## Build

1. **Refusal without a sentence.** When the instant faucet answers with a status and no JSON `error` (for example a firewall page), setup shows one plain sentence that names what happened and what to do, not "gave no reason (status 403)".
2. **The no-SOL next step.** When setup ends with less SOL than it needs to start, `next` is at most two sentences: what happened, and the single best next action with one link or command. The other routes stay available in a separate field `other_ways` (a list), not in `next`.
3. Both the CLI `setup` and the MCP `solive_wallet_setup` get the same fields.

Files: `packages/cli/src/faucet.ts`, `packages/cli/src/wallet.ts`, and the MCP setup action only if its output shape must change.

## Tests

The no-SOL `next` stays within two sentences in every refusal case; a non-JSON 403, 429 and 503 each give a plain sentence; `other_ways` lists the routes that `next` used to name.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Change only the files named above and their tests; other workers change other first-run files in parallel.
- Read `docs/maintainers/first-run.md` (Walk log, Plan) for the observed behaviour this job fixes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
