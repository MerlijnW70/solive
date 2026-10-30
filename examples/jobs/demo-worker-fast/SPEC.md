# Job: The demo worker delivers within seconds

In two owner tests the demo worker took a few minutes to deliver a demo job, because each round lists all open jobs with the `jobs` command and then waits. A first-time user who just hired an agent thinks nothing is happening. Make delivery fast.

## Build

1. **Find new demo escrows quickly.** Instead of listing every open job each round, find escrows whose spec hash is a demo spec soon after they are created: for example by watching the program's new intents (the client's notifications or a websocket subscription), or by a cheap newest-first read like the paged scan `find_jobs` uses. Keep a slow full scan as a fallback, so nothing is missed after a restart or a dropped connection.
2. **Same safety as today.** Only demo escrows, each delivered once (the state file still guards restarts), claims taken as today, the same stake cap.
3. **Measure.** On devnet, with a fresh wallet funded from the instant faucet (at most 0.5 SOL, returned afterwards to CMbTKrcjd6kVd2VDMUzN6qkMoxsRSDgGHvjFKxB5n9iy), create three demo escrows and record the time from the escrow's send to the worker's announcement, before and after your change. Report the times.
4. **Tell the user.** In `docs/first-hire.md` and the guide's demo line, state how long a demo delivery takes, from your measurement.

Files: `scripts/demo-worker.mts`, `scripts/demo-worker.sh`, the demo worker tests, `docs/first-hire.md`, the demo section of `docs/maintainers/operations.md`, and the one demo line in `packages/cli/src/agent/mcp.ts`.

## Tests

A new demo escrow seen by the fast path is delivered once; the fallback scan still finds one the fast path missed; a dropped subscription or failed read recovers; non-demo escrows are ignored.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Another worker changes other files in parallel; touch only the files this spec allows.
- Never touch a real home, wallet or key outside your job directory.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
