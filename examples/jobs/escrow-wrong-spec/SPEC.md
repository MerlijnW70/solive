# Job: MCP escrow refuses a wrong spec and previews its full cost (D6)

The deep audit of the CLI (audit A2, findings W2, W8, W9) found that the MCP escrow tools differ from the CLI on a wrong spec, and preview less than they spend.

## Build

1. **A wrong spec is refused on send.** `specPreflight` (`packages/cli/src/agent/wallet/escrow-terms.ts`) returns `wrong: true` when the spec at `spec_url` does not hash to `spec_hash`. `wallet_escrow` and `wallet_escrow_plan` (`agent/wallet/escrow.ts`) only show the line on preview and then lock funds on send. CLI `create --yes` refuses the same case unless `--allow-wrong-spec`. Refuse on send with the same refusal text unless an explicit `allow_wrong_spec` input is given, and say in the tool description what it does. An unreadable url still only warns.
2. **One vault rent.** Vault rent is computed three ways (`agent/wallet/costs.ts`, `agent/budget.ts`, `history-profit.ts`), and a Token-2022 sell mint gets a low preview. Use one function that sizes the vault for the mint's program and extensions, everywhere.
3. **Follow-up claim transactions are counted.** An escrow with claims may send extra transactions (`escrow-claims.ts`), but the preview's total counts one fee. Count every transaction the send will make.

## Tests

Each item has a test that fails without its fix: `wallet_escrow` with `send: true` and a mismatched spec sends nothing; with `allow_wrong_spec` it sends; a Token-2022 sell mint preview shows the larger vault rent; an escrow with follow-up claim transactions previews their fees.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/agent/wallet/escrow.ts`, `escrow-terms.ts`, `escrow-claims.ts`, `costs.ts`, `history-profit.ts`, `agent/budget.ts`, their tests and the generated tool reference. Do not touch `agent/work-claims.ts`, `agent/claim-line.ts`, `claim-commands.ts` or `monitor.ts`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
