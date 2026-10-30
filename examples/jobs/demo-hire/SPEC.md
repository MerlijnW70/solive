# Job: A first hired job that a novice can finish

The first-run walk found that hiring needs a spec hosted at a public url and a judge with Docker, both beyond a novice (plan item 9, Target flow "The first hired job"). Build a demo path that lets a first-time user hire an agent, see the work delivered, judge it without Docker, and pay, in minutes.

## Build

1. **Demo specs.** Add a small set of demo specs under `examples/demo/` (at least three), each a task a single JavaScript module can solve, with a `judge-cases` block so the ViperJS sandbox judges it. Each spec is served from a stable public https url that fits the memo url rule (for example the repository's raw file url at a pinned commit, or the faucet service), so the user never hosts anything.
2. **The AI offers them.** The `hire` prompt and the market guide tell the AI to offer a demo spec when the user has none, show the spec in plain words, pin it by its hash, and escrow it with the user's own wallet as judge. Keep the guide's line and word limits.
3. **A demo worker.** Add a small worker that this project runs next to the devnet solver: it watches for open escrows whose spec hash is one of the demo specs, claims when the escrow takes claims, and delivers a correct solution to the judge, within minutes. Its solutions live next to the demo specs. It runs from a script the owner starts as a service (like the filler); it holds its own devnet key from an env var or file path, never committed.
4. **Judge without Docker.** The guide and the `judge` prompt name `judge --sandbox viper` as the way to check a demo job, and Docker only when a spec needs a container.
5. **Docs.** A short section in `docs/first-job.md` or a new page under `docs/` walks the demo end to end in at most 5 steps.

Files: `examples/demo/`, the demo worker under `services/` or `scripts/`, `packages/cli/src/agent/mcp.ts` (guide and prompts), docs, and tests. Do not change `add-to.ts` or setup.

## Tests

Every demo spec parses and its judge cases pass against its own solution in the ViperJS sandbox and fail against a wrong one; the demo worker, against a stubbed transport, claims and delivers only demo escrows, delivers each once, and ignores others; the guide and prompts stay within their limits and name only served tools.

In the report, describe one end-to-end run on devnet you did with the demo worker and a fresh wallet: the escrow, the delivery, the viper verdict and the release, with signatures. Spend at most 1 SOL of devnet SOL and return what is left to CMbTKrcjd6kVd2VDMUzN6qkMoxsRSDgGHvjFKxB5n9iy.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Read `docs/maintainers/first-run.md` (Target flow, Plan) first; this job implements part of it.
- Another worker changes other first-run files in parallel; touch only the files this spec allows.
- Never touch a real home, wallet or key: tests use stubs and temporary directories.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
