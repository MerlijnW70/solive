# Job: one install line for Claude Code

Adding solive to Claude Code needs a different command on native Windows (`cmd /c npx`) than elsewhere. Newcomers pick the wrong one.

## Build

- A new command `intent-engine add-to claude` runs `claude mcp add` with the right server command for the operating system: `cmd /c npx -y @intent-engine/cli mcp --url devnet --wallet` on native Windows, `npx -y @intent-engine/cli mcp --url devnet --wallet` elsewhere.
- It refuses with a clear message when `claude` is not installed, and says what it added when it succeeds.
- It works when started as `npx -y @intent-engine/cli add-to claude`.
- `README.md` (through `identity.toml` and `scripts/identity.sh`) and `docs/ai.md` show this one line for Claude Code on every system, instead of the separate Windows form.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Tests stub the `claude` program; they never run the real one.
- Regenerate `docs/reference` with the documented command.
- Change only `packages/cli`, `docs`, `README.md` and `scripts/identity.sh`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover Windows and non-Windows, `claude` missing, and a failing `claude mcp add`.
3. The README and `docs/ai.md` show one line for Claude Code.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
