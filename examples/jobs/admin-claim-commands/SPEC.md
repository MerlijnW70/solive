# Job: CLI paths for the announce fee and late claim lists, documented exit codes (E6)

The deep audit (A1 L24, A3-09) and later reviews found program instructions with no CLI or MCP path and undocumented behaviour.

## Build

1. **Announce fee.** `set_announce_fee` has a core builder used only by tests, while every other config admin instruction has a CLI command (`packages/cli/src/admin-commands.ts`). Add `admin set-announce-fee` with the same preview, `--yes` and multisig proposal support as the other admin setters.
2. **Late claim lists.** `list_claimants` lets an owner who opened claims add an invite list afterwards, but has no caller (`packages/core/src/claim-list.ts`). Add a `claims list` CLI command, previewed and sent like the other claim commands, and the matching MCP path if claim lists are offered there.
3. **Exit codes documented.** `crank`, `migrate --all` and `mandate-revoke` exit 3 on partial failure, documented nowhere. Document the exit codes in the CLI reference.
4. **The devnet filler prices its floor.** `scripts/filler.sh` passes `--min-profit` in TEST without `--sol-value`, so the solver warns at every start. Add the matching `--sol-value` at the filler's own issue rate.

## Tests

Each item has a test that fails without its fix: `admin set-announce-fee` previews and builds the instruction and proposes through the multisig path; `claims list` builds `list_claimants` and refuses when claims are not open; the exit codes appear in the generated reference; the filler's solve command has a matching `--sol-value`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/admin-commands.ts`, `claim-commands.ts`, `arg-options.ts`/`arg-usage.ts`/`arg-admin.ts` (new options only), `scripts/filler.sh`, `docs`, their tests and generated references. Do not touch `agent/work-claims.ts` or `agent/claim-line.ts`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
