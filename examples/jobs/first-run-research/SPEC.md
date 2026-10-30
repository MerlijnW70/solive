# Job: Research the most frictionless first run

A first-time user on a fresh Windows PC opened PowerShell, pasted the Codex install command from this repository, and found the flow "very broken": Codex did not know the market, and the wallet had no SOL. Two fixes are in main now (an instant devnet faucet that setup asks first, and a market guide in the MCP instructions). Find out what still stands between a user with almost no technical knowledge and a first success, and design the flow that removes it.

The target user can open a terminal (PowerShell, macOS Terminal or a Linux shell) and paste one line from the README. They do not know what Node.js, npm, MCP, a wallet, devnet or an escrow is.

## Research

1. **Walk the real path** on this machine in a clean, throwaway environment: a temporary `HOME` and `USERPROFILE`, a temporary npm cache and prefix. Never touch the real `~/.codex`, `~/.claude`, `~/.config/intent-engine` or any real key. Start from the README and follow only what a user would see. Record every step: the exact command, the exact output, the time it took, and every point where the user would not know what to do next. Cover Windows PowerShell and Linux (WSL distro `solive`). Use the Codex and Claude Code CLIs only where a temporary home keeps them away from the real config; if that is not possible, read their behaviour from their docs and say so.
2. **The missing prerequisites.** What happens when Node.js is missing or too old, when `npx` is not found, when Codex or Claude Code is not installed, when Docker is missing, on a corporate proxy or TLS-intercepting antivirus (this machine runs Norton). Name the exact error text a user would see.
3. **Best practice.** Study how at least 6 well-regarded developer tools onboard a first-time user from one pasted command (for example the Vercel, Supabase, Stripe and GitHub CLIs, `npm create` style starters, and MCP servers that ship an installer), and which of their patterns fit a tool that AI agents drive. Cite each source with its url.
4. **The AI side.** After the server is added, what does Codex (and Claude Code) show and do on the first message? What must the server's instructions, prompts and tool results contain so the AI leads a novice to a first success without the user knowing any concept?

## Design

Write the target flow, step by step, from the pasted line to a first success (a first swap, and separately a first hired job), with what the user sees at each step and what the tool does for them. It must:

- keep the CLI scriptable for agents: no prompt that waits for input when stdout is not a terminal, and JSON output unchanged where agents read it;
- fail with one plain sentence and the exact next command, never a stack trace;
- state what is optional (for example Docker only for judging) at the moment it matters, not before.

Then give a prioritized plan: each change with its user-visible effect, the files it touches, a size (S/M/L), and which changes can run in parallel without touching the same files.

## Deliver

One `git format-patch` file that adds a new page named first-run.md under `docs/maintainers/` with the walk log (a table of steps, commands, output excerpts, times and friction points), the prerequisite failures, the cited best practices, the target flow and the plan. Paragraphs under 80 words. No code changes. Announce the patch's sha256 to the judge.

## Rules

- Follow `CONTRIBUTING.md`. Never name a private tool.
- Spend at most 1 SOL of devnet faucet SOL in total, and send any SOL you get back to the address the brief names.
- No publishing, no pushing, nothing on mainnet.

## Acceptance

1. The walk log is real: commands and outputs are reproducible on this machine.
2. Every best-practice claim cites a url, and the plan maps each friction point found to a change.
