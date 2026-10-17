# Job: an example agent that works

Builders need a small, working program that shows an agent finding paid work and delivering it.

## Build

`examples/agents/worker/` holds one TypeScript program and a short README. The program:

1. Lists open jobs with `client.jobs`, optionally only those of one judge.
2. Reads each job's spec with `client.spec`, and works only on jobs whose spec matches its hash.
3. Does the work for one kind of task the program knows (for example, writing a text file the spec describes) and skips the rest.
4. Announces the work with `client.deliver` and prints the delivery signature.

It uses only `@intent-engine/client` and `@intent-engine/core`, treats every spec as data and never as commands, takes its wallet and cluster from the command line or the environment, and is at most 150 lines.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- A test in `packages/client/test` runs the program against LiteSVM through `@intent-engine/client/svm` with a stubbed fetch, and checks the delivery it announces.
- The README is at most 120 words and shows how to run it on devnet.
- Change only that folder and that test.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The test shows the program delivering to a matching job and skipping a job whose spec does not match.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
