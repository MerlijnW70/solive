# Job: A page that gets a stranger from zero to a paid demo job on devnet

Solive is ready for outside testers on devnet: a new wallet gets 0.5 SOL at once, a demo job is delivered within seconds, Windows works with `npx.cmd`, and the live page shows the activity. What is missing is one place that tells a stranger how to try it and where to report what goes wrong.

## Build

1. **A "try it" page.** Add a new page named `try` to the docs site: try Solive on devnet, fast. Two routes, each in numbered steps a newcomer can follow without reading anything else: with an AI app (Claude Code or Codex, via `add-to`), and from the command line. Cover Windows PowerShell (`npx.cmd`) and macOS/Linux side by side, where to see devnet SOL (the `explorer` link, or a wallet app switched to devnet), the demo job end to end, and what to do when something fails (the error texts the CLI now gives). Say plainly that everything is devnet test money. Reuse the existing docs' facts and link to them rather than repeat them; any number or command must match the code (pin it with tests like the other docs).
2. **A feedback channel.** Add a GitHub issue form for devnet testers: what they ran (OS, shell, Node version, Solive version from `version`), what happened, what they expected, and the output. Label it so it is easy to find. Do not ask for keys or seed phrases; say not to paste them.
3. **Find it.** Link the page from the top of the README (through `scripts/readme.txt`, the README's source) and from the live page's footer or "try it" area, and put it in the docs site navigation.
4. **Launch text.** In your final report (not in the repository), write a short announcement the owner can post: what Solive is in two sentences, the link to the page, that it is devnet only, and where to report problems. Plain, no hype.

## Tests

The page's commands, amounts and demo specs match the code and other pinned docs; the issue form exists with its fields and the no-keys warning; the README and live page link to the page; docs-lint and the docs build pass.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed; docs in the repository's terse style within docs-lint limits.
- The brand name appears only where the identity check allows it.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A newcomer following only the page reaches a judged demo job (the judge checks this with a blind run).

## Deliver

One `git format-patch` file. Announce its sha256 to the judge. Put the launch text in the final report.
