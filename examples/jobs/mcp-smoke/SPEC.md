# Job: a hire-and-earn smoke test through the MCP tools

Nothing checks, release by release, that a hirer and a worker can still complete a paid job through the MCP server the way an AI app does.

## Build

- A module in `packages/cli` that drives two MCP servers, a hirer's and a worker's, each with its own wallet, through one paid job: `solive_wallet_escrow` with a spec hash and url, `solive_find_jobs`, `solive_get_spec`, `solive_hash`, `solive_wallet_deliver`, `solive_wallet_check_delivery`, `solive_wallet_attest`, `solive_wallet_receipt` with `wait`, and `solive_wallet_unwrap`. Each step checks the fields the next step relies on and stops with the step's name and the tool's problem on the first failure.
- A test runs that module in process against the existing test harness on every CI run.
- `scripts/mcp-smoke.sh <url> <hirer key> <worker key> <spec url>` runs the same module against a real cluster over stdio, using the built `intent-engine mcp`, and prints one line per step and the release signature.
- `docs/maintainers/operations.md` adds running it against devnet to the release steps, in at most three sentences.

## Rules

- The script refuses `mainnet`, sends only after each preview, and spends at most 0.01 SOL of escrow plus fees.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Change only `packages/cli`, `scripts` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover the whole run passing, a step failing reported by name with the tool's problem, and the script refusing a mainnet url.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
