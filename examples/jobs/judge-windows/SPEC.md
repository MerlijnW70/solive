# Job: Judging a demo job works from Windows, without WSL or Docker

A first-time user on Windows has PowerShell, Node.js and the AI app, nothing else. To judge a demo job the AI runs `intent-engine judge --sandbox viper`. Nobody has run that on native Windows. Make it work, and make it easy for the AI.

## Build

1. **Walk it on native Windows.** In a throwaway USERPROFILE (never the real one), with a fresh devnet wallet from the instant faucet (at most 0.5 SOL, returned afterwards to CMbTKrcjd6kVd2VDMUzN6qkMoxsRSDgGHvjFKxB5n9iy), make a demo escrow and run `npx.cmd -y @intent-engine/cli judge --sandbox viper ...` from Windows PowerShell exactly as the guide tells the AI. Record every failure: keypair file checks, paths, the ViperJS wasm, child process flags, quoting.
2. **Fix what breaks**, on Windows and without weakening any check on Linux or macOS.
3. **One tool for the AI.** Add an MCP wallet tool that judges fetched work in the ViperJS sandbox for a spec with a `judge-cases` block and returns the verdict, the case results and the work's sha256, without sending anything; the AI then attests with `solive_wallet_attest`. It refuses a spec without judge cases and says to use `judge --sandbox docker`. Name it in the market guide and the `judge` and `hire` prompts instead of the shell command, within their limits.
4. **Docs.** `docs/judge.md` and `docs/first-hire.md` name the tool and say that Windows needs neither WSL nor Docker for a demo job.

Files: `packages/cli` judge and sandbox code, a new tool under `packages/cli/src/agent/wallet/`, `packages/cli/src/agent/mcp.ts` (guide and prompts), tests, `docs/judge.md`, `docs/first-hire.md` (only the judging step). Do not change `scripts/demo-worker.*`.

## Tests

The new tool passes a correct demo solution and fails a wrong one, refuses a spec without judge cases, sends nothing, and names only served tools; any Windows fix has a test that runs on every platform.

In the report, give the Windows walk: each command, its output and each fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Another worker changes other files in parallel; touch only the files this spec allows.
- Never touch a real home, wallet or key outside your job directory.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
