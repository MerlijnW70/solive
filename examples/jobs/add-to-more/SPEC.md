# Job: one install line for Cursor, VS Code and OpenClaw

`intent-engine add-to` knows only `claude` and `codex`. For Cursor, VS Code and OpenClaw, `docs/ai.md` and `docs/openclaw.md` ask people to hand-edit JSON, and the VS Code line needs a different escaped form in Windows PowerShell.

## Build

- `intent-engine add-to cursor` merges a `solive` server into `~/.cursor/mcp.json` under `mcpServers`.
- `intent-engine add-to vscode` merges a `solive` server with `"type": "stdio"` into the VS Code user `mcp.json` under `servers`: `%APPDATA%\Code\User` on Windows, `~/Library/Application Support/Code/User` on macOS, `~/.config/Code/User` elsewhere.
- `intent-engine add-to openclaw` merges a `solive` server with `requestTimeoutMs` 60000 into `~/.openclaw/openclaw.json` under `mcp.servers`.
- Each uses the same server command and `--wallet-per-trade` / `--wallet-per-hour` limits as `add-to claude`, with `cmd /c` on native Windows.
- Each creates the file and its folders when missing, keeps every other key and server as it was, and reports the path and whether it added or replaced the entry.
- A file that is not valid JSON is left untouched: the command refuses, names the path and prints the entry to paste by hand.
- `docs/ai.md` shows one `add-to` line for each of these apps, and `docs/openclaw.md` leads with `add-to openclaw`, keeping the manual entry as a fallback.

## Rules

- Reuse `packages/cli/src/add-to.ts`, `launch.ts` and the existing `add-to` argument parsing. Put the new code in a new module if `add-to.ts` would pass 500 lines.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Tests use a temporary home and never touch a real app config.
- Regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover, for each app: a missing file, a file with other servers and keys left untouched, an existing `solive` entry replaced, invalid JSON refused with the file unchanged, Windows and non-Windows commands, and the limits passed through. VS Code is tested on all three config locations.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
