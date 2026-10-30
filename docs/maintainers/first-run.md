# First run

What stands between a novice and a first success with Solive, found by walking the path on 2026-10-30, and the flow that removes it. The user can open a terminal and paste one line. They do not know Node.js, npm, MCP, a wallet, devnet or an escrow.

## How the walk ran

Machine: Windows 11 Home build 26300 with Windows PowerShell 5.1, Node.js 22.22.1 through nvm for Windows, Norton antivirus, and the WSL distro `solive` with Node.js 22.23.3. Codex and Claude Code are installed on Windows; neither is installed in WSL.

Every walk used a fresh temporary `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, npm cache and npm prefix, plus `CODEX_HOME` and `CLAUDE_CONFIG_DIR` inside it. The real `~/.claude.json` and `~/.codex/config.toml` kept their earlier modification times. Two builds were walked:

- npm: `npx -y @intent-engine/cli`, which served 0.1.70, the `latest` tag that day.
- main: commit `a4bf5ba`, built and packed with `pnpm pack` in WSL, installed with `npm install -g` into the temporary prefix. It reports 0.1.71.

Codex and Claude Code sessions were not started: both keep their sign-in inside the real config folders, which this walk must not read. What they do on the first message comes from their docs and from driving the MCP server over stdio with a small client that sends `initialize`, `tools/list`, `prompts/list` and `tools/call`, as both apps do.

## Walk log

Times are wall-clock seconds for the whole command. "Cold" means an empty npm cache.

| # | Shell, build | Command | Output excerpt | Time | Friction |
|---|---|---|---|---|---|
| 1 | PowerShell, npm | `npx -y @intent-engine/cli add-to codex` (cold) | `{"added": "solive", "to": "Codex", ... "startup_timeout_sec": 90, "next": "restart Codex, then ask it to set you up and make your first swap"}` | 11.5 | Works. The Codex line is in `docs/ai.md`, not in the README. |
| 2 | PowerShell, npm | `npx -y @intent-engine/cli add-to claude` | `{"added": "solive", "to": "Claude Code", "ran": "claude mcp add --scope user solive -- cmd /c npx -y @intent-engine/cli mcp --url devnet --wallet", ...}` | 4.0 | Works. |
| 3 | PowerShell, npm | the same line again | `solive is already added to Claude Code for your user, so nothing was changed; to replace it, run claude mcp remove --scope user solive, then npx -y @intent-engine/cli add-to claude`, exit 1 | 3.7 | Pasting the README line twice fails. Codex in step 1 run twice exits 0. |
| 4 | PowerShell, npm | `npx -y @intent-engine/cli setup` | `"sol": "0"`, `"next": "your wallet holds no SOL yet and devnet refused the airdrop, as it often does; intent-engine setup --faucet files a faucet request with a signed-in GitHub CLI (gh) ...; or open https://github.com/MerlijnW70/solive/issues/new?template=faucet.yml&address=... ...; or ask another devnet faucet ..."` | 3.0 | 0.1.70 has no instant faucet. The `next` text runs to 100 words with four routes; two need GitHub and a wait for the faucet's next run. This is the owner's "the wallet had no SOL". |
| 5 | PowerShell, main | `npm install -g` of the four packed tarballs | `added 203 packages` | 10.7 | Test setup only, not a user step. |
| 6 | PowerShell, main | `intent-engine setup` (first instant faucet request) | `"faucet": {"refused": "the instant faucet gave no reason (status 403)"}`, `"sol": "0"`, then the same long `next` | 2.5 | The instant faucet refuses. See [The faucet refusal](#the-faucet-refusal). |
| 7 | WSL, npm | `npx -y @intent-engine/cli add-to codex` (cold) | `codex is not installed or not on PATH; install Codex, then run this again`, exit 1 | 8 | Clear on Linux. It does not say how to install Codex. |
| 8 | WSL, npm | `npx -y @intent-engine/cli add-to claude` | `claude is not installed or not on PATH; install Claude Code, then run this again`, exit 1 | 1 | Same. |
| 9 | WSL, main | `intent-engine setup` (second instant faucet request) | `"faucet": {"refused": "the instant faucet gave no reason (status 403)"}`, `"sol": "0"` | 2 | Same refusal from Linux. |
| 10 | WSL, main | `intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600` | the six-line `summary`, `"sent": false`, `"next": "nothing was sent: ... holds no SOL, so this preview could not be simulated; get devnet SOL: ..."` | 0 | The preview is clear. The first swap stops here: no SOL. |
| 11 | WSL, main | the same with `--yes` | `nothing was sent: ... holds no SOL to pay the network fee; get devnet SOL: ...`, exit 1 | 1 | One sentence, then the same 100-word route list. |
| 12 | WSL, main | `intent-engine jobs` | open jobs; every one shown has `"specUrl": null` and the same owner | 42 | Slow, and no job shown has a spec a worker can read. |
| 13 | WSL, main | `intent-engine sandbox doctor` | Docker 29.9.2, the checks shown `"ok": true`, and one stray `Killed` line before the JSON | 17 | Docker matters only for judging; the stray line looks like a crash. |
| 14 | PowerShell, npm | MCP server as Codex starts it: `cmd /c npx -y @intent-engine/cli mcp --url devnet --wallet` (cold) | `initialized after ...`, 35 tools, prompts `["start"]` | 8.6 | Codex's default `startup_timeout_sec` is 10; `add-to codex` sets 90, a hand-written config keeps 10. |
| 15 | PowerShell, npm | the same, warm cache | `initialized after ...`; the instructions have no job guide | 1.8 | 0.1.70 lacks the market guide: the owner's "Codex did not know the market". |
| 16 | PowerShell, main | MCP server, `tools/call solive_wallet_setup` | `"sol": "0"`, the faucet link and the five notice lines | 0.6 | Same dead end inside the AI. |
| 17 | PowerShell, main | MCP server, `tools/call solive_find_jobs` | jobs with `"spec_url": null` | 44.7 | Close to Codex's default `tool_timeout_sec` of 60. |

The main build's instructions start with the five notice lines, then `Start with solive_wallet_setup`, a seven-line "How a job works" guide and the tools grouped by task. It serves the prompts `start`, `hire`, `earn` and `judge`. The npm build serves only `start`.

## The faucet refusal

Both requests reached Vercel and came back `403 Forbidden` with the header `X-Vercel-Mitigated: deny` and a plain-text body. A `GET` to `/api/drip` with a browser or `node` user agent got the same; other paths on the host answered `404`. So the platform firewall, not the faucet function, refuses this network: the function answers `405` to a `GET` and JSON on every refusal, as its README says.

The CLI read the plain-text body as JSON, found no `error`, and printed `the instant faucet gave no reason (status 403)`. No SOL arrived, so nothing had to be sent back. Neither walk could make the first swap or the first hired job.

## Missing prerequisites

| Case | How it was produced | What the user sees |
|---|---|---|
| Fresh Windows PowerShell | `powershell -ExecutionPolicy Restricted -Command "npx -y @intent-engine/cli version"` | `npx : File C:\nvm4w\nodejs\npx.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies ...` |
| The same with `npx.cmd` | `npx.cmd -y @intent-engine/cli version` under the same policy | `{"version": "0.1.70"}`: works |
| Node.js missing | `PATH` set to `C:\Windows\System32;C:\Windows` | `npx : The term 'npx' is not recognized as the name of a cmdlet, function, script file, or operable program.` |
| Node.js too old | Node.js 20.19.5 | five `npm warn EBADENGINE Unsupported engine` blocks naming `required: { node: '>=22.12.0' }`, then the command runs; `setup` worked |
| Codex missing, Windows | Node.js 20 run with a `PATH` without Codex | `codex mcp add failed with exit code 1, so nothing was added: 'codex' is not recognized as an internal or external command,\u000d operable program or batch file.` |
| Codex or Claude Code missing, Linux | WSL | `codex is not installed or not on PATH; install Codex, then run this again` |
| Docker missing | not produced; `sandbox doctor` passed | Docker is needed only by `judge --sandbox docker`; the MCP `hire` and `judge` prompts name `--sandbox viper` as the Docker-free path |
| TLS-intercepting antivirus | not produced: with Norton running, npm, the devnet node and Vercel answered without certificate errors | the CLI adds the system certificate store at start (`packages/cli/src/bin.ts`), but `npx` downloads the package before that code runs, so an intercepting proxy fails in npm first |

Windows clients run with the `Restricted` policy when no scope sets one, and `Restricted` blocks every `.ps1` file, `npx.ps1` included ([Microsoft](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)). PowerShell prefers `npx.ps1` over `npx.cmd`, so the README line fails on such a PC before Solive runs. This machine's `CurrentUser` scope is `RemoteSigned`, which hides it.

The Windows "not installed" text never shows: `add-to` treats only exit code 9009 from `cmd.exe` as "not found" (`packages/cli/src/launch.ts`), and on this machine `cmd.exe /d /c <unknown>` exits 1, checked with three argument shapes. The user gets the raw `cmd` error with an escaped carriage return.

For an intercepting proxy, npm's `cafile` setting is the documented fix ([npm](https://docs.npmjs.com/cli/v11/using-npm/config#cafile)). Its error text was not produced here and is left out.

## How others onboard

| Tool | Pattern | Fit for an agent-driven tool |
|---|---|---|
| Stripe CLI | `stripe agent setup` detects Claude Code, Codex and Cursor and installs its MCP server for each; `--yes` skips prompts, `--json` prints the plan without changes ([Stripe](https://docs.stripe.com/cli/agent/setup)) | One command for every detected app, instead of one per app |
| Stripe CLI | `stripe sandbox create` gives working test keys without an account, gated by a proof-of-work challenge, with `--non-interactive` for agents ([Stripe](https://docs.stripe.com/cli/sandbox)) | Free test funds with an abuse gate that works from any network, unlike an IP block |
| create-next-app | one `npx create-next-app@latest` line; prompts with recommended defaults, and `--yes` takes them all ([Next.js](https://nextjs.org/docs/app/api-reference/cli/create-next-app)) | Defaults that need no answers; prompts only for humans |
| GitHub CLI | `GH_PROMPT_DISABLED` turns off every interactive prompt ([GitHub](https://cli.github.com/manual/gh_help_environment)) | A switch that keeps agents out of prompts |
| Vercel CLI | `vercel login` uses the OAuth device flow, so sign-in works from any browser-capable device ([Vercel](https://vercel.com/changelog/new-vercel-cli-login-flow)) | One link for the human step, the rest stays in the terminal |
| Supabase CLI | states that Docker is needed in the step that starts the local stack, not in the install step ([Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started)) | Name Docker when judging starts, not at setup |
| Playwright MCP | one line per app, Codex included: `codex mcp add playwright npx "@playwright/mcp@latest"` ([Playwright MCP](https://github.com/microsoft/playwright-mcp)) | The README shows the Codex line next to the Claude Code line |
| Claude Code installer | tells the user which shell they are in from the error they see, and maps each install error to a fix ([Claude Code](https://code.claude.com/docs/en/setup)) | Turn a raw shell error into the next command |
| Command Line Interface Guidelines | prompt only when stdin is a TTY, rewrite errors for humans, suggest the next command ([clig.dev](https://clig.dev/)) | The rule set for every message below |

## The AI side

Codex reads the server's `instructions` from `initialize` as server-wide guidance; its MCP page does not mention MCP prompts. Defaults: `startup_timeout_sec` 10, `tool_timeout_sec` 60. `default_tools_approval_mode` takes `auto`, `prompt`, `writes` or `approve` ([Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).

Claude Code lists each MCP prompt as `/servername:promptname (MCP)`, so the main build's prompts show as `/solive:start`, `/solive:hire`, `/solive:earn` and `/solive:judge`. It warns above 10,000 tokens of tool output and cuts at 25,000 by default, and `--scope user` makes the server available in every project ([Claude Code](https://code.claude.com/docs/en/mcp)).

So on the first message Codex has only the instructions and the user's words; Claude Code also offers `/solive:start`. Both see the same instructions, which therefore carry the whole first run. A novice's first message is "set me up", and the first tool result decides the outcome: today it is a wallet with no SOL and four routes, two of them needing a GitHub account.

Claude Code and Codex side by side, from the walk and the docs above:

| Point | Claude Code | Codex |
|---|---|---|
| README line | in the README | only in `docs/ai.md` |
| Pasted twice | exit 1, "already added" | exit 0, entry rewritten |
| App missing, Windows | raw `cmd` error | raw `cmd` error |
| Server start | no startup limit set by `add-to` | `add-to` sets `startup_timeout_sec` 90; the default 10 is near the cold start in step 14 |
| Slow tool | a default tool limit far above any call in this walk | `find_jobs` in step 17 against the default `tool_timeout_sec` of 60 |
| Entry point | `/solive:start` or a sentence | a sentence only |
| After adding | new session | new `codex` run |
| Approval | its permission settings | `default_tools_approval_mode` |

Both break at the same place first: setup leaves the wallet without SOL.

What the server must give the AI:

- a setup result that ends in SOL, or in one route the AI can hand over as one link, with no GitHub account;
- one `next` sentence per result, short enough to repeat word for word, and the concepts named only when the user meets them;
- a market with at least one job a novice can take, whose spec the AI can read;
- a hire path that hosts the spec for the user, since a novice has no public url;
- tool calls that finish well inside Codex's default `tool_timeout_sec`.

## Target flow

The pasted line is the same for both apps; only the app name differs. On Windows the README shows `npx.cmd`, which runs under every execution policy; elsewhere `npx`.

1. The user pastes `npx -y @intent-engine/cli add-to claude` or `add-to codex`. Without that app on `PATH` it prints one sentence and the app's install command, found by a `PATH` lookup, not by an exit code.
2. `add-to` registers the server, creates the wallet and asks the instant faucet, so SOL is there before the app starts. A terminal shows three plain lines: added, wallet funded, what to type. A pipe gets the JSON it gets today.
3. Running it twice reports "already added" and exits 0. Codex also gets `tool_timeout_sec`.
4. The user restarts the app. Claude Code needs a new session, Codex a new `codex` run.
5. Claude Code: the user types `/solive:start` or "set me up and make my first swap". Codex: the sentence, since it has no prompt menu. The AI shows the five notice lines and the balance, previews 0.05 SOL for at least 5 TEST, and sends after "yes".
6. Each app asks before an MCP call according to its own approval settings, on top of the server's preview. The AI waits for the fill and reports the TEST received: the first swap.

The first hired job:

1. The user asks to hire. The AI drafts a spec with a check from a demo template, and the server hosts it and pins its hash, so no url is needed.
2. It previews the escrow with the user's wallet as judge, and sends after "yes".
3. A demo worker run by this project, like the devnet solver, delivers within minutes.
4. The AI fetches the work and runs the check in the ViperJS sandbox, which needs no Docker. Docker is named only when a spec needs a container.
5. On a pass it previews the release, sends after "yes", and shows the receipt: the first hired job.

Every failure on this path is one sentence plus the next command. Nothing waits for input unless stdout is a terminal.

## Plan

| # | Change | User-visible effect | Files | Size | Fixes |
|---|---|---|---|---|---|
| 1 | Find and lift the platform firewall rule that denies `/api/drip`, and keep the per-address and per-caller limits in the function | `setup` funds a new wallet | the faucet project's firewall settings, `services/faucet/src/http.ts` | S | step 6, 9 |
| 2 | Read a non-JSON refusal as "the instant faucet is not reachable from this network", and cut the no-SOL `next` to one sentence and one link; move the other routes into a list field | the AI repeats one sentence | `packages/cli/src/faucet.ts`, `packages/cli/src/wallet.ts` | S | step 4, 6, 11, 16 |
| 3 | Gate the faucet with a proof-of-work challenge, as Stripe's sandbox does, so limits do not depend on IP blocks | funding works on shared and corporate networks | `services/faucet/src/drip.ts`, `services/faucet/src/request.ts`, `packages/cli/src/faucet.ts` | M | step 6, 9 |
| 4 | Release 0.1.71 to npm | the instant faucet and the job guide reach `npx` users | release flow only | S | step 4, 15 |
| 5 | Detect a missing app with a `PATH` lookup and print its install command; treat "already added" with the same command as success | clear Windows message; the README line is safe to paste twice | `packages/cli/src/add-to.ts`, `packages/cli/src/launch.ts` | S | step 3, Codex missing |
| 6 | Run setup inside `add-to`, set Codex `tool_timeout_sec`, print plain lines on a TTY and JSON otherwise | funded wallet before the first message | `packages/cli/src/add-to.ts`, `packages/cli/src/render.ts` | M | step 4, 17 |
| 7 | README: both apps, `npx.cmd` on Windows, Node.js as one line with its install link; the same in the guides | no execution-policy wall, Codex users find their line | `identity.toml`, `docs/ai.md`, `docs/quickstart.md` | S | step 1, fresh PowerShell |
| 8 | Make `find_jobs` answer within a few seconds and list only jobs whose spec can be read, unless asked for all | the earn path shows takeable jobs | `packages/cli/src/agent/jobs.ts` | M | step 12, 17 |
| 9 | Demo hire path: hosted demo spec, a demo worker next to the devnet solver, ViperJS judging in the `hire` prompt | a first hired job without a url or Docker | `packages/cli/src/agent/mcp.ts`, `examples/`, `scripts/filler.sh` | L | hosting, empty market |
| 10 | Refuse Node.js older than 22.12 at start with one sentence and the download link | no wall of `EBADENGINE` warnings | `packages/cli/src/bin.ts` | S | Node.js too old |
| 11 | Find what prints the stray `Killed` line around `sandbox doctor` and keep it out of the output | doctor output reads as a pass | `packages/cli/src/sandbox-doctor.ts` | S | step 13 |

Order: 1 and 4 first, since nothing else counts while a new wallet stays empty. Then 2, 5, 7 and 8, then 6, 3, 9, 10 and 11.

Parallel groups, no two of which touch the same file: {1}, {2}, {5}, {7}, {8}, {9}, {10}, {11}. Change 6 shares `add-to.ts` with 5 and runs after it. Change 3 shares `faucet.ts` with 2 and runs after it. Change 4 runs alone.
