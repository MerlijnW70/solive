# Job: Program-wide scans are bounded and refute checks before sending (D18)

The deep audit (A1 L2, L4, L5, L18; A3-05) found unbounded scans and missing pre-checks in `packages/client`.

## Build

1. **heldShares filters by wallet early.** `heldShares(wallet)` reads the history of every held announcement on the cluster, one by one, before filtering by wallet, so its cost grows with everyone's held shares and anyone can grow it. Make the cost follow the wallet's own shares: bound the scan, read with limited concurrency, and filter by wallet before reading history where the data allows; when a bound is hit, say the result is incomplete.
2. **Funding reads have a hard total.** `funding.ts` does not count zero-lamport transfers against its read cap, so a padded payer can force thousands of transaction reads in a reputation read. Add a hard total that ends in an incomplete result.
3. **Refute checks its split claim.** `refute` sends without checking the caller's split recipients and weights against the release's split hash, which the program will refuse after a fee is paid. Check it before sending and refuse with `NotRefutable`.
4. **confirm-release refuses a half target.** A target with payees but no `sha256` or `attestor` skips the payee check and returns success. Refuse that combination.

## Tests

Each item has a test that fails without its fix: with many unrelated held announcements, `heldShares(w)` makes a bounded number of history reads and says when it is incomplete; a padded funder hits the hard cap; a mismatched split claim is refused and nothing is sent; payees without `sha256` give `InvalidInput`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client/src/held-shares.ts`, `funding.ts`, `announcement-sends.ts`, `confirm-release.ts`, their tests, `docs/sdk-client.md` and `api-report.txt` through the repo's script. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
