# Job: advance-epoch previews, partial failures exit nonzero, true help and Ledger texts (D14)

The deep audit of the CLI (A2 X2, X3, X4, X7, X8, C7, C8) found these faults.

## Build

1. **advance-epoch previews.** `advance-epoch` revokes every mandate and outstanding signature of the owner at once and sends without a preview or `--yes` (`packages/cli/src/commands.ts`), while `advance-nonce` previews. Route it through the same preview and `--yes` path; a missing user state gives a clear refusal, not a plain `Error`.
2. **Partial failures exit nonzero.** `migrate --all` collects failed batches but returns success, and `crank` reports per-intent errors with exit 0; only `mandate-revoke` uses the partial exit. Exit with the partial code when any part failed.
3. **True Ledger texts.** The refusal for a Ledger keypair says "because it also signs messages" for every command not in the Ledger list, including commands that sign no message; and transaction-only commands that already sign through the Ledger path (`claims open|standby|leave|advance|settle`, `close-legacy`, `migrate`) are missing from the list, so that path cannot run. Add them, reword the refusal, and update `docs/quickstart.md`.
4. **True help.** `help mandate` lists `--min-result --max-result --attestor`, which no mandate subcommand takes; `help judge` omits the `judge digest` options; the `claim-held --yes` refusal names only some required options; `set-economics --partner-cut` accepts values the program refuses. Make help match what each command accepts, and refuse out-of-range values at parse time with the program's bound.

## Tests

Each item has a test that fails without its fix: `advance-epoch` without `--yes` returns a preview and sends nothing; `migrate --all` with one failing batch and `crank` with one failing intent exit with the partial code; `claims open --keypair usb://ledger` is accepted; `help mandate` does not list `--attestor` and `help judge` lists `--salt`; `set-economics --partner-cut 10001` is a usage error.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines; split a file that would pass the limit.
- Only `packages/cli/src/commands.ts`, `main.ts`, `migrate-commands.ts`, `crank.ts`, `ledger-keys.ts`, `arg-options.ts`, `arg-usage.ts`, `arg-announce.ts`, `arg-admin.ts`, `docs/quickstart.md`, their tests and generated references. Do not touch `agent/wallet/*`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
