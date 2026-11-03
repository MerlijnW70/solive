# Job: Intent reads must fit a stock node's filter limit (N1)

A stock Solana node refuses `getProgramAccounts` with more than 4 filters (`Too many filters provided; max 4`). `packages/client/src/rpc-transport.ts` sends the discriminator, the data size and one memcmp for each field of the query from `intentMatches` (`packages/client/src/intent-filters.ts`), so a query with 3 or more fields sends 5 or more filters. `client.ts` passes a caller's filter straight through. The public devnet node has been seen to accept 5, so tests against it and the fake nodes do not catch this.

## Build

1. First measure: run the current code against a local `solana-test-validator`, with real intent accounts, and report which public read methods and which query shapes fail.
2. Make every intent query work on a stock node and return exactly what it returned before. Fit the filters within the limit in a sound way: adjacent bytes such as kind and status merge into one memcmp, and fields that do not fit are checked on the client after the read with the existing `intentMatchesQuery`, so results stay exact. Never drop a field without checking it. Choose which fields go to the node so that the most selective ones do.
3. Do the same for `engineAccounts` and any other caller of the shared account filters that can pass the limit, or show that it cannot.
4. The fake node used by the client tests refuses more than 4 filters from now on, so this cannot come back unseen.

## Tests

Each fails if its behaviour breaks: every combination of the query fields sends at most 4 filters; each combination returns exactly the accounts a full client-side check returns, on a mixed set; a merged memcmp matches only the right kind and status together; the fake node refuses a fifth filter; a run against a local validator, gated the way the repository's existing validator tests are, covers the shapes that failed in the first step.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No change to the shape of public results. Tests never use the public network.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
