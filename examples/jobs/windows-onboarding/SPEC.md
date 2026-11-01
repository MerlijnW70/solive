# Job: Fix what stops a new Windows user

A walk through Solive as a new Windows user (Windows 11, PowerShell 5.1, Node 22) found these problems. Fix them so a newcomer gets from the README to a judged demo job without guessing.

## Build

1. **PowerShell first.** In `README.md` and `docs/ai.md`, show the Windows PowerShell line (`npx.cmd …`) next to the plain `npx` line, under one clear label, before the first command a newcomer runs. Quote the first words of the error a plain `npx` gives under a restrictive policy (`running scripts is disabled`), so a user who hits it recognises it.
2. **Windows PATH.** In `docs/quickstart.md` step 1, add the Windows way to put npm's global folder on PATH (`npm config get prefix` names it; add it to the user PATH, open a new terminal), next to the existing Linux line. Say plainly that the `npx.cmd` function needs no PATH change.
3. **Funding text.** `docs/quickstart.md` and `docs/first-job.md` say `setup` asks devnet for 1 SOL. The first drip is the instant faucet's 0.5 SOL, with devnet's airdrop as the fallback. Make the text match what `setup` does.
4. **CLI demo path.** Link `docs/first-hire.md` from `docs/ai.md`. Add a short CLI section to `first-hire.md` that runs a demo job from the command line: the three demo specs with their urls and hashes from one source of truth in the code (do not duplicate them by hand; render or test them against the list the MCP server uses), the escrow command, how the worker's delivery shows up, and the judge command.
5. **Work url hint.** `deliveries` shows the work url only with `--judge-keypair`. When it hides the url, its output says so in one short line and names the flag.
6. **Rate limit text.** When a CLI command gets HTTP 429 from the node, it says the public devnet node rate-limited it and to retry in a minute or pass another `--url`, instead of the bare `HTTP error (429)`. Keep the exit code a failure.

## Tests

Each fails if its behaviour breaks: the README and ai.md show the PowerShell line before the first run and quote the error; the demo specs in the docs match the list in the code; `deliveries` without `--judge-keypair` prints the hint when a url exists; a 429 prints the new text and still fails; docs text is pinned like other docs.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines; docs paragraphs within the docs-lint limit.
- Additions only to tool and CLI output, apart from the 429 wording. No exit code changes meaning.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
