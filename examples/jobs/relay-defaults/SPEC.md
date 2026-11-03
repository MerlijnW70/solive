# Job: A relayer works with its documented flags, and its preview checks what submit checks (E4)

The deep audit (A2 X1, A5) found that `mcp --relayer` with the documented flags refuses every relay on devnet, and that the relay preview promises checks it does not run.

## Build

1. **A working default.** `--relay-max-lamports` defaults to 0 (`packages/cli/src/command-builders.ts`), so with devnet's crank bounty every relay is refused as too costly, while `docs/mcp.md` says `--relayer` with `--relay-fee` lets the relayer publish intents. Choose a sound default from the create fee and the crank bounty read from the config, or require the flag with a clear refusal; show the value in the usage text and document it.
2. **Preview runs the admission checks.** `submit_signed_intent` says `preview_signed_intent` checks the same input first, but the preview runs none of the relay checks (mint, fee floor, lifetime, cost, per-owner rate, hourly budget, size, nonce taken), and its cost line leaves out the fee-account rent and second signature that admission reserves (`agent/signed-submit.ts`, `agent/relay.ts`). Run the same admission checks in the preview without reserving anything, and show the same cost.

## Tests

Each item has a test that fails without its fix: `mcp --relayer k --relay-fee M=0` relays on a config with a nonzero crank bounty; `preview_signed_intent` refuses an unaccepted mint as submit does and shows the cost submit reserves; the preview reserves nothing.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/command-builders.ts`, `arg-usage.ts` (relay usage only), `agent/signed-submit.ts`, `agent/signed-prepare.ts`, `agent/relay.ts`, `docs/mcp.md`, their tests and generated references. Another job edits the texts of `signed-submit.ts`; change only its preview and admission logic, and rebase on main before delivering. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
