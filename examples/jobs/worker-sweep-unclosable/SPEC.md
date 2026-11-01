# Job: A token account that cannot close must not stop the leftover sweep

The local worker's leftover return (`solive_wallet_worker` with `return_leftovers`, `packages/cli/src/agent/wallet/worker-return.ts`) closes the worker's token accounts and sweeps SOL back. If one account cannot be closed (frozen with a zero balance, a Token-2022 account with withheld fees, or a foreign close authority), the whole sweep is refused, so leftovers cannot come back until someone fixes that account by hand.

## Build

1. Before building the sweep, leave out every account the token program would refuse to close, and keep it under `kept` with the reason. Sweep everything else.
2. The key is still deleted only when the worker holds nothing at all; an account left out keeps the key.
3. The preview says which accounts are left out and why.

## Tests

Each fails if its behaviour breaks: a frozen empty account is left out and named, the rest is swept; a Token-2022 account with withheld fees is left out; an account with another close authority is left out; the key is kept while any account is left out; a sweep with no such account works as today.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Tool output changes are additions only.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
