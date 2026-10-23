# Job: History that shows a worker's work and pay

In a devnet job chain on 0.1.46, a worker announced three deliveries and was paid for one, yet `wallet_history` returned `"activity": []`: it lists only escrows this wallet created. A contractor saw `paid_to` show token accounts, such as `3mozCw…`, rather than the worker wallets its `wallet_attest` calls named, and its claim and its delivery to the client were missing. The description says it shows "what this wallet did".

## Required

- `wallet_history` gives `paid_to` as the wallet that owns the paid token account, keeping the token account in a separate field, and every output field has a description that says what it is.
- `wallet_history` also lists, newest first and within its limit, the work this wallet announced with `wallet_deliver`: the escrow, the announcement's signature and time, and whether a release paid this wallet for it, with the amount and the release signature when it did. It reads only this wallet's own history and the escrows involved.
- `wallet_history` lists the claims this wallet took or dropped, with the escrow and the outcome of the stake when known.
- The description says what the history covers and what it leaves out.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli/src/agent/wallet/history.ts`, new files next to it, `packages/client` where a read needs a shared helper, their tests, and the generated references and docs the tests check. No program change.
- Keep the tool name and its existing inputs. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A LiteSVM test in which a worker announces work that a release then pays shows the worker's `wallet_history` listing that work as paid, with the amount and release signature, and `paid_to` on the payer's side naming the worker's wallet.
3. A test fails when the judge makes `paid_to` return the token account again.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
