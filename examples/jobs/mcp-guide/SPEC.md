# Job: Teach the AI how the job market works

A first-time user added the MCP server to Codex and asked for work to be done. Codex did not know when to hire a paid agent, who judges, or how judging works, so the flow felt broken. Today the server's instructions list tools by task but never explain the market. Fix that inside the server, so any MCP host learns it on connect.

## Build

1. **How it works.** Add a short section to the server instructions (the `instructions` the wallet MCP server sends), after the notice and before the tool list, of at most 12 lines. It must say, in plain words:
   - the three roles: the hirer locks payment in an escrow, a worker delivers, a judge (the escrow's attestor: the hirer itself, another wallet, or a committee) checks the work against the pinned spec and only then is the worker paid;
   - when to hire: a task that another agent can do and that a check can decide, with the spec pinned by its hash;
   - the order of a job: hire (spec, escrow, judge) → worker claims and delivers to the judge → judge fetches the work, checks it, attests → payment; and who calls which tool at each step;
   - what judging needs: the judge runs the spec's check itself, in Docker by default, or in the ViperJS sandbox for a single JavaScript module whose spec carries judge cases; a judge without either should say so instead of approving;
   - that every step costs devnet SOL, and where setup gets it.
   Every sentence must match the code and the tools as they are: check each against the source and tests, and name in the report where each fact comes from.
2. **Guided prompts.** Next to the existing `start` prompt, register three MCP prompts: `hire` (write a spec with a check, pin it, escrow it with a judge, wait for and judge the delivery), `earn` (find a job, check its spec matches, claim, deliver, follow it to payment), and `judge` (fetch a delivery, run the check, attest pass or refuse). Each prompt is one user message of at most 6 sentences that walks the AI through the tools in order and tells it to preview and ask before sending.
3. **Docs.** Add the same roles and prompts to `docs/mcp.md` in at most 3 short paragraphs and one table (prompt, what it does). Keep each paragraph under 80 words.

## Text rules

Follow the repository's rules for AI-facing text: focused, small, no filler, nothing that is not true of the code. Name tools exactly as the server serves them.

## Tests

- The served instructions contain the new section, stay within the line limit, and name only tools the server serves with that wallet.
- The three prompts are registered with the wallet and absent without it, and each message names only served tools.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `packages/cli/src/agent/mcp.ts`, `packages/cli/src/agent/wallet/guard.ts` if the instructions live there, their tests, and `docs/mcp.md`. Do not change setup, the faucet, `docs/quickstart.md` or `docs/ai.md`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every sentence true of the code, and a fresh agent reading only the instructions can name who does what in a job.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
