# Job: The README gets a novice to the first command on any system

The first-run walk found that the README shows only the Claude line, a fresh Windows PowerShell refuses `npx`, and nothing says Node.js is needed (plan item 5).

## Build

1. The README's first lines show both apps, Claude Code and Codex, each with one copyable line, plus the Windows PowerShell form using `npx.cmd`.
2. One line before them: what to install first (Node.js 22.12 or later, with the official download link), and how to check it.
3. `docs/ai.md` and `docs/quickstart.md` match: the same lines, `npx.cmd` for Windows PowerShell, and the instant faucet as the first way to get SOL.
4. If the README is generated from `identity.toml`, change it there and regenerate.

Files: `README.md` and its source in `identity.toml`, `docs/ai.md`, `docs/quickstart.md`, and any docs test that pins these lines.

## Tests

Existing docs tests pass; add a test that the README names both apps and the Node.js requirement. Paragraphs stay under 80 words.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Change only the files named above and their tests; other workers change other first-run files in parallel.
- Read `docs/maintainers/first-run.md` (Walk log, Plan) for the observed behaviour this job fixes.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested as written.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
