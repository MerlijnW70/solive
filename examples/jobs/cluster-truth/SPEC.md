# Job: Texts name the cluster in use, and each bound has one source (H4)

**Rules:**
1. No text names devnet when the url is another cluster.
2. Every bound is defined once and imported where it is used.
3. Every numeric setting read from the environment is validated at startup.

The reviews of F3 and F6 found the gaps below.

Devnet named on other clusters:
- the `other_ways` list in `packages/cli/src/wallet.ts` (`APP_WAY` and the devnet faucet link);
- `walletEmpty` in `packages/cli/src/agent/wallet/guard.ts`;
- two output descriptions in `packages/cli/src/agent/wallet/account.ts`.

Unvalidated environment settings:
- `RELAY_MAX_TTL` in `packages/cli/src/command-builders.ts` duplicates `MAX_EXPIRES_IN`;
- `FILLER_INTERVAL` in `scripts/filler.sh` is not validated;
- the timeout in `examples/jobs/word-count/check.mjs` becomes NaN on a bad value.

## Build

1. **Devnet wording.** Search the whole repo, including docs, for every text that names devnet. Gate each one by cluster, or make it cluster-neutral. List each one in the report.
2. **Duplicated bounds.** Search for duplicated bound constants and replace each copy with one import. List them in the report.
3. **Environment settings.** Search shipped scripts and examples for numeric environment reads. Refuse a bad value at startup, naming the variable.

## Tests

- On localnet, testnet and a custom url, setup output and every refusal name no devnet.
- `FILLER_INTERVAL=abc` is refused at startup.
- Each new test fails without its fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only the files named here and the ones the searches find, with their tests and generated references. No program change.
- Run only the touched tests plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
