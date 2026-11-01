# Job: Walk through Solive as a brand-new Windows user

An outside user on Windows got stuck installing the MCP server (a PATH problem first, then an empty wallet and no clear way to fund it). Walk the newcomer's path on this Windows machine, exactly as the public docs tell it, and report every place a newcomer would stop or guess.

Research only. Do not change the repository, commit or push anything. Never change the real user's configuration: no edit under the real `%USERPROFILE%`, `%APPDATA%` or `~/.claude*`, no real `claude mcp add`. Run everything with `USERPROFILE`, `HOME`, `APPDATA` and `LOCALAPPDATA` pointed at a new empty folder, so every file a step writes lands there. If a step would touch the real profile anyway, stop that step and report it. Devnet only; spend nothing beyond the faucet's own drip.

## Walk

1. Start from the repository's `README.md` on GitHub (`main`) and the docs it links, as a newcomer reads them. Use only what they say, in their order.
2. Install and run with the published npm package (`npx -y @intent-engine/cli@latest`), in PowerShell and in cmd, as the docs suggest. Include `setup`, `add-to claude` (with the redirected profile), `balance`, and the demo job the docs offer.
3. Note each failure with the exact command, the exact output, and why a newcomer would not know what to do. Look especially for: PATH or `npx` problems on Windows (`npx.cmd`, spaces in paths, PowerShell execution policy, Node version), unclear text, and steps that assume Linux or macOS.

## Deliver

The report text: the walk as a numbered list with each step's command and outcome, then a ranked list of problems (blocking first), each with the evidence, the likely cause in the code or docs (file and line where you can), and the smallest fix as a description. State what you could not test. Terse.

## Acceptance

1. Every reported problem has a command and output the judge can reproduce.
2. Nothing in the repository or the real user profile changed.
