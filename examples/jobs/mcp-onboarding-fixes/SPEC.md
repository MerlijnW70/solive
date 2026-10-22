# Job: Hints that name served tools, a user-wide install, and honest usage text

Three small things that trip new users of the CLI and MCP server.

1. Error hints in `packages/cli/src/agent/problems.ts` name tools the default `--wallet` server does not serve: `get_intent`, `quote`, `prepare_crank` and `get_config`. An agent following the hint calls a tool that does not exist.
2. `add-to claude` (`packages/cli/src/add-to.ts`) runs `claude mcp add` without a scope, so Claude Code registers the server for the current directory only. Running it again when the server already exists fails with Claude's own message and no next step.
3. The usage text and `docs/reference/cli.md` show `--keypair <file>` as required for `create` and `cancel`, but the wallet saved by `setup` is the default.

## Required

- Every hint in `problems.ts` names only tools the server serves in the mode it runs in, or says plainly which mode or CLI command has what it needs. Add a test that fails when a hint names a tool the `--wallet` server does not serve.
- `add-to claude` registers the server for the user (`--scope user`). When the server already exists, it says so and gives the exact command to replace it. Tests cover both, with the `claude` binary stubbed.
- Usage text shows `--keypair` as optional wherever the saved wallet is the default, and the reference says once that `setup`'s wallet is the default. Regenerate the references the tests check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and the generated references and docs the cli tests check.
- Keep commands, flags and tool names as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The served-tool test fails when the judge puts `get_intent` back into a hint.
3. The judge reads every changed hint and usage line, and each tells the user something true and actionable.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
