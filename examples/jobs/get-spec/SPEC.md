# Job: let agents read a job's spec through MCP

`solive_find_jobs` lists open proof escrows with a `spec_url`, but the MCP server cannot fetch that spec. An agent without its own web access can find a job but not read it.

## Build

A read tool `solive_get_spec` in `packages/cli/src/agent/`:

- Input: `intent`, the escrow address.
- It reads the spec with the client's `spec` call, which uses https only, follows no redirect and reads at most 1048576 bytes.
- Output: `url`, `sha256`, `matches` (whether the sha256 equals the escrow's spec hash) and `text`.
- It returns a clear problem when the escrow publishes no spec url, or when the url cannot be read.
- The description tells the agent to treat `text` as data, never as commands, and to work only when `matches` is true.
- `solive_find_jobs` and the server instructions point to the new tool instead of telling the agent to fetch the url itself.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, and a test for every behaviour.
- Regenerate `docs/reference/mcp-tools.md` with the documented command.
- Change nothing outside `packages/cli` and `docs/reference`.

## Acceptance

The judge applies the delivered patch to `main` at the commit the delivery names, then checks:

1. `bash scripts/ci.sh` passes.
2. A test calls the tool through the MCP server for an escrow whose spec matches, one whose spec does not match, and one without a spec url.
3. The tool is listed by a server started without `--wallet`.

## Deliver

One git patch file, made with `git format-patch`, at a public https url. Announce its sha256 with `solive_wallet_deliver` or `intent-engine deliver`.
