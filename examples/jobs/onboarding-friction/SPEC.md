# Job: Fix what stops a newcomer in the first minutes

A first-time user followed only the public docs (docs site and README) with `@intent-engine/cli` 0.1.67 in a fresh Linux shell. They reached no first success.

On a separate Windows machine, the install fetched the package over plain http because npm's registry was set to `http://`. Nothing warned about it, and the MCP server `add-to` installs fetches the package again on every start.

## Required

1. **Funding, up front.**
   - The Quickstart says before the first command that devnet airdrops are often refused. It then lists the ways to get SOL: the repository faucet (`setup --faucet` with a signed-in `gh`, or the faucet link, which opens a public GitHub issue and needs a GitHub account), how long each takes, and other devnet faucets such as faucet.solana.com.
   - `setup`'s next-step text names the same options in short words.
   - The scheduled faucet answers more often than once an hour. Choose an interval GitHub Actions allows, and keep the faucet's balance alerts in the monitor consistent with it.
2. **Install.** The Quickstart leads with `npx -y @intent-engine/cli <command>`, which works without global installs, and keeps the global install as an option. That option documents the user-prefix fix (`npm config set prefix ~/.npm-global` plus PATH) for the EACCES error, next to the version-manager advice.
3. **Previews without funds.** A command that previews when run without `--yes` (`create swap`, `create attested` and the other `create` kinds) still shows its terms on an unfunded wallet. It says the preview could not be simulated because the wallet holds no SOL, and repeats how to get SOL. It does not fail with only `Unfunded`. With `--yes` it still refuses to send.
4. **Plain refusals for missing orders.** `cancel --nonce N` (and the other commands that take a nonce of the user's own order) says when the wallet has no order with that nonce and points to `intent-engine list`. A derived address the user never saw is not the main message.
5. **Empty job lists.** `intent-engine jobs` with no result says that no job is open right now, and how to wait for one or post one. The first-job guide and the AI page say the same.
6. **One tool for the first-job guide.** The first-job guide works with `intent-engine` alone: making extra wallets (for example `setup --keypair <file>` or a documented equivalent) and moving devnet SOL between the user's own wallets. If a SOL transfer command is missing, add one with the preview-then-`--yes` pattern the other sends use, on devnet only like the rest. The Solana CLI becomes optional.
7. **The MCP startup line about a second node** reads as information, not as an error. The MCP page and the AI page say what it means and how to set `--confirm-url`.
8. **The MCP "Deliver work" section** names the tools of the setup `add-to` installs (`--wallet`), and says which tools the read-only server has instead.
9. **Prerequisites.** The AI page says Claude Code (or the chosen host) must be installed before `add-to`. The README points to the Quickstart's funding section.
10. **Plain-http registry.** `add-to` and `setup` detect when npm's registry is `http://` (from `npm config get registry`, run safely with a timeout and no shell interpolation). They warn with the exact command to switch to `https://registry.npmjs.org/`. `add-to` refuses to install the MCP server until the registry is https, unless the user passes an explicit flag. Tests cover http, https, a missing npm and a failing npm.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change the program, the IDL or the generated client.
- Keep TypeScript files under about 500 lines.
- Docs follow the repository's docs rules: docs-lint, short paragraphs, every command validated. Tool descriptions and next-hints stay short and accurate, and generated references are regenerated.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. Tests show each CLI change in Required 3–6 and 10.
3. A test fails when the judge makes `add-to` accept an `http://` registry without the flag.
4. A test fails when the judge makes an unfunded `create swap` preview fail again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
