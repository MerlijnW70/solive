# Job: The spec pins the check the judge runs (judge-run-pinned)

**Rules:**
1. When a spec carries a `judge-run` block, the check the judge runs is exactly the one the block pins. That covers the image, the command, the hidden check files, the time limit and the resources. A judge cannot run anything else and still sign.
2. A limit the spec pins is part of the bar. Work that exceeds a pinned time or memory limit has fallen short of the spec, so the outcome is `fail`. Limits the judge picks itself keep today's outcomes from the verdict model (`packages/cli/src/verdict-model.ts`).
3. A spec without a `judge-run` block works exactly as today.

Today the spec's hash pins the text, but for Docker judging the command comes from the judge's own `--run`, `--check` and `--sandbox-*` flags (`packages/cli/src/judge.ts:387`, `packages/cli/src/sandbox.ts:51`). The MCP text says the judge "runs the spec's check itself" (`packages/cli/src/agent/mcp.ts:102`), but nothing makes that true. Only the `judge-cases` block is read from a spec (`packages/cli/src/viper.ts:12`).

## Build

1. **The block.** A fenced `judge-run` block holds one JSON object:
   - `image`: required, `<name>@sha256:<64 hex>`;
   - `run`: required, the command;
   - `timeout`: required, whole seconds;
   - `check_sha256`: optional, the sha256 of the hidden check files, defined over a canonical encoding of a directory or file that you specify and test;
   - `memory` and `cpus`: optional, in today's `--sandbox-memory` and `--sandbox-cpus` formats.

   An unknown field, a bad value, more than one block, or a spec with both `judge-run` and `judge-cases` is refused before anything runs, and the reason names the field. Reuse the existing block parsing and validators. Do not write a second parser next to `casesOf`.
2. **One place resolves the check.** One function turns the spec and the judge's flags into the check to run, and every route uses it: `judge`, `judge --watch` and committee judging. With a `judge-run` block:
   - `--run`, `--sandbox-image`, `--sandbox-memory`, `--sandbox-cpus`, `--sandbox none` and `--sandbox viper` are refused if they differ from the block, and accepted if equal;
   - `--check` is required when `check_sha256` is set, and refused when its sha256 differs; it is refused when the block has no `check_sha256`;
   - `--timeout` may only be at least the pinned `timeout` plus the judge's own overhead, and that overhead is a named constant you choose and justify;
   - list every other flag that could change what runs, and handle each one.
3. **Pinned limits decide.** Under a pinned `timeout`, a check still running at that limit is `fail`. Under a pinned `memory`, a container that Docker reports `OOMKilled` is `fail`. Put both rows in the verdict model's classifier and its docs table, not in a route. The judge's own overall deadline stays infra.
4. **Hirer and worker see it.**
   - `solive_get_spec` and the CLI `spec` show the pinned check: image, command, limits and whether hidden check files are pinned.
   - Hirer-side spec checks, `solive_wallet_escrow` and its preflight, and `solive_wallet_seal_spec` refuse a malformed block before money moves.
   - `solive_wallet_judge_work` refuses a spec with a `judge-run` block and says to use `judge`, as it does today for specs without `judge-cases`.
5. **Docs.** Update `docs/judge.md`, `docs/maintainers/judge-internals.md` and every tool description or next-hint that says what the judge runs, so that each says when the check is pinned and when it is the judge's choice. The verdict model's docs-table test must cover the new rows.

## Tests

- **Parser table:** every field valid and invalid, unknown field, two blocks, both block kinds, and CRLF and LF specs giving the same result.
- **Resolver table:** every flag from item 2, equal and different, with and without a block.
- **End to end with Docker** through the real `judge` command:
  - a pinned check that passes is signed;
  - a check over its pinned `timeout` fails and is not signed;
  - a pinned-memory OOM fails;
  - a judge-chosen-limit OOM stays infra;
  - a `--run` that differs is refused before anything runs;
  - a `--check` whose hash differs is refused;
  - a spec without a block behaves as before.
  If Docker is unavailable, the test fails loudly; report the skip count.
- **The same refusals** through `judge --watch` and committee judging, and the MCP refusal from item 4.
- **The existing suites** of every package you change still pass. Do not weaken any assertion.

## Self-check before delivering

A reviewer will attack your patch in these ways. Check each one yourself and report what you found:
- Find another route to the same hole: another entry point (CLI vs MCP, committee vs single judge, `--watch`), another flag, an environment variable, a default that fills in for a missing flag, or a config file.
- Can a judge run a different command, image or check files and still sign? Try equal-looking values: whitespace, a digest in another case, a path that resolves to different files, symlinks in the check directory.
- Can a worker turn a pinned-limit fail into infra, or a judge turn a host fault into a fail?
- Can the block be read differently by `get_spec` and by `judge`?
- Boundary values: `timeout` 0, 1 and the maximum, memory at the format limits, an empty `run`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Specs without a `judge-run` block must judge, print and sign exactly as before.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, rerun the tests, and name the base commit in the report.
- Never write to the shared git config.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Report

- Every flag and path from item 2, and how each is handled.
- The canonical encoding for `check_sha256`, with its test.
- The self-check findings.
- **Same defect elsewhere:** `path:line — why`, including outside the files you changed.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that no route can run an unpinned check under a `judge-run` block and still sign, and that the self-check attacks fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
