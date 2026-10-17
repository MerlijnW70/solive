# Job: plain words in the MCP server

The server's instructions and tool descriptions are long and technical. An AI repeats that tone to the user.

## Build

- The server instructions in `packages/cli/src/agent/mcp.ts` total at most 150 words, in plain English. Any term a newcomer would not know gets a few plain words.
- Every wallet tool description is at most 60 words and says what the tool does for the user first.
- The wallet notice keeps all its safety points in at most 5 short lines.
- Keep every rule that protects the user: previews before sending, approval before `send: true`, test network only, the key stays local.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- A test checks the word limits above.
- Regenerate `docs/reference` with the documented command.
- Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The word-limit test exists and passes.
3. The judge reads the new texts and finds them plain and complete.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
