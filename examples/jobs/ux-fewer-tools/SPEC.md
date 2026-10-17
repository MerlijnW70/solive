# Job: fewer tools by default

`intent-engine mcp --wallet` serves every tool the server has. A daily user needs far fewer, and the long list makes an AI pick worse.

## Build

- `intent-engine mcp --url devnet --wallet` serves at most 20 tools: the ones a person uses day to day (wallet setup, balance, history, intents, swap, auction, recurring buys, escrow, release, delivery, receipts, cancel, estimate, finding jobs and reading a job's spec).
- A new flag `--all-tools` serves every tool, as today.
- A server started with `--relayer` or `--agent` still serves the tools those flags need.
- A server without `--wallet` is unchanged.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference` with the documented command.
- Mention `--all-tools` in `docs/mcp.md` in one sentence.
- Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A test lists the tools of a default `--wallet` server, at most 20, and of an `--all-tools` server, all of them.
3. A test shows `--relayer` and `--agent` still bring their tools.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
