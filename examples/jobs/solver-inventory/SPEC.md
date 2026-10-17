# Job: a solver that fills from its own tokens

Every fill now needs a route: a Jupiter swap, or tokens minted with `--issue`. A solver that already holds the output token could pay an order from its own balance, with no swap fees, no slippage and a smaller transaction.

## Build

- `inventoryPricer` in `packages/solver/src` takes rates in the same form as `issuePricer`, plus a function that reads the solver's balance of a mint. It quotes `amountOut = amountIn * out / in`, with no route instructions, and only when the solver holds at least that `amountOut`.
- A quote says whether it is an inventory fill. For an inventory fill, the balance check in `tick` expects the solver's input account to grow by at least `fees.net` and its output account to shrink by at most `required`. Route fills keep today's check.
- `firstPricer(...pricers)` returns the first non-null quote, asking the pricers in order.
- `intent-engine solve` takes `--inventory <input mint>:<output mint>=<out>/<in>,...` with the syntax of `--issue`. With `--jupiter` or `--issue`, inventory is asked first and the other pricer second. `--inventory` alone is also valid.

## Rules

- Keep every safety check `tick` has today. An inventory fill never spends more of the output token than `required`, and is refused when the balance check fails.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, files under 500 lines, nothing bypassed.
- The commit check refuses URL-like text inside template literals and numbers with units in docs. Write `"https://" + host` as a string concatenation, and never weaken the check.
- Document the flag in `docs/solver.md` in at most three short sentences. Regenerate `docs/reference`. Change only `packages/solver`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: an inventory quote with enough balance; no quote when the balance is short; a fill whose simulation keeps the expected balances is sent; a fill whose simulation spends more output than `required` is refused; `firstPricer` order and fall-through; `--inventory` parsing, alone and with `--issue`.
3. A test in `packages/solver/test/load.test.ts`, on its LiteSVM program, fills a real intent from inventory and checks that the receiver got at least `required`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
