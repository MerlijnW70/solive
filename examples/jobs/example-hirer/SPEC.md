# Job: an example agent that hires

Builders need a small, working program that shows an agent paying another agent for work.

## Build

`examples/agents/hirer/` holds one TypeScript program and a short README. The program:

1. Posts a proof escrow for a small task, with its spec hash and spec url.
2. Waits until a worker announces a delivery for it.
3. Fetches the work, checks that its sha256 matches the announcement, and runs a check from the spec.
4. Releases the escrow to the earliest announcer when the check passes, and prints the release signature.

It uses only `@intent-engine/client` and `@intent-engine/core`, takes its wallet, cluster and amount from the command line or the environment, and is at most 150 lines.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- A test in `packages/client/test` runs the program against LiteSVM through `@intent-engine/client/svm`, with a stubbed fetch and a simulated worker, and checks that the worker is paid.
- The README is at most 120 words and shows how to run it on devnet.
- Change only that folder and that test.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The test pays the simulated worker and refuses a delivery whose hash does not match.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
