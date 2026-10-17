# Job: one install line for Codex

Adding solive to Codex fails in two ways today. Codex can mark the server failed on its first `npx` start, while the package downloads. On native Windows the command also needs `cmd /c`.

## Build

- `intent-engine add-to codex` runs `codex mcp add solive -- <server command>`, with `cmd /c` on native Windows, just as `add-to claude` does.
- It then sets `startup_timeout_sec = 90` on the `solive` entry in `~/.codex/config.toml`, keeping every other line of that file as it was.
- It refuses with a clear message when `codex` is not installed, and reports what it changed.
- `docs/ai.md` shows this one line for Codex on every system, instead of the separate forms and the manual timeout step.

## Rules

- Reuse what `add-to claude` already does: `packages/cli/src/add-to.ts` and `launch.ts`.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Tests stub `codex` and use a temporary home; they never touch a real Codex config.
- Regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover Windows and non-Windows, `codex` missing, a failing `codex mcp add`, a config without and with an existing `solive` entry, and other entries left untouched.
3. `docs/ai.md` shows one line for Codex.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
