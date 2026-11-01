# Job: Count workers by wallet in the live feed

A count of the program's paid jobs from the chain found that the live feed in `services/live` takes a release's `IntentAttested.payee` as the worker (`src/activity.ts`, the line choosing `attested?.payee ?? released?.worker ?? paid.solver`). That field is the payee's token account, not its wallet. So `workers_7d` and `top_workers[].wallet` count and show token accounts. The figures happen to match today because each wallet has one canonical account per mint, but a wallet paid through two accounts counts twice, the page shows addresses nobody recognises, and a split payout credits only the announcing worker with the whole amount.

## Build

1. **Wallets, not accounts.** Resolve each payee token account to its owner wallet from the transaction's token balances (`postTokenBalances` owner), and use the wallet for `workers_7d`, `top_workers`, the event stream and anything else that names the worker. Keep the account only where the feed already exposes it as an account.
2. **Splits.** For an `IntentSplit` release, credit each recipient wallet with its own share, one job counted once in `paid_jobs_7d`, and each recipient counted as a worker. Use the program's split event and the balances in the same transaction; cite the event fields you rely on.
3. **When the owner is unknown.** If a transaction's balances do not name the owner, fall back to today's behaviour for that entry and do not invent a wallet.
4. **Saved state.** State saved by the current version still loads. Entries it already holds may keep their old payee; new entries use wallets.

## Tests

Each fails if its behaviour breaks: one wallet paid through two token accounts counts as one worker; `top_workers` shows the owner wallet; a split with three recipients counts one paid job, three workers, and each share credited to its own wallet; a missing owner falls back without a crash; old saved state loads.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Public SDK exports only in `services/live`.
- No change outside `services/live`, except its page tests in `packages/cli/test/live-site` if they need new fixtures, and docs that describe it.
- Read-only devnet, few and spaced, if you try it live.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.
3. A preview built from the patch reports the same paid jobs and paid amount as before, and its worker wallets match the payee owners on chain for three sampled jobs.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
