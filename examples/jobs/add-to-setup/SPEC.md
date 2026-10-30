# Job: add-to sets up a funded wallet in the same step

Today `add-to claude` and `add-to codex` only register the server. The wallet and its SOL come later, inside the app, which is where first-time users got stuck. Make the one pasted line do the setup too (plan item 7, Target flow steps 1 to 3).

## Build

1. **Setup in the same run.** After the server is registered (or found already registered), `add-to` runs the same setup as `intent-engine setup` on devnet: create the wallet if there is none, ask the instant faucet, fall back as setup does. `--no-setup` skips it. A wallet that already exists is kept and only its balance is shown.
2. **Codex timeouts.** For Codex, also set the server's tool timeout in `~/.codex/config.toml` next to the startup timeout `add-to` already sets, high enough for the slowest tool call measured in the walk log, and keep both on a second run.
3. **What a person sees.** When stdout is a terminal, print three plain lines and nothing else: that the server was added (or already was), that the wallet holds N SOL (or the one sentence setup gives when it holds none), and exactly what to do next: restart the app, then type the start sentence (for Claude Code also name `/solive:start`). When stdout is not a terminal, print the JSON it prints today plus the setup result under one new key.
4. **Never blocks.** No prompt waits for input. A faucet refusal or a network failure never makes `add-to` fail once the server is registered.
5. **Docs.** `docs/ai.md` says the line also sets up and funds the wallet.

Files: `packages/cli/src/add-to.ts`, `packages/cli/src/render.ts` or wherever terminal output is chosen, the setup call site, their tests, and `docs/ai.md`.

## Tests

Terminal output is exactly three lines for both apps, with a funded wallet and with an empty one; piped output is JSON with the setup key; `--no-setup` skips setup; an existing wallet is kept; a second run keeps both Codex timeouts; a faucet failure still exits 0.

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
