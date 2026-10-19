# Job: the solver prices rent from the cluster

`packages/solver/src/costs.ts` prices rent as 3,480 lamports per byte-year over 2 years, which comes to 6,960 per byte. Devnet and mainnet charge 5,080 since SIMD-0437. As a result, `createdRent` overstates the rent a fill opens, so the solver skips fills under `maxRent` that it could take, and it reports rent too high. The CLI already reads the live rate (`rentRate`, `rentExemptFor` from commit 58380f6).

## Build

1. **Live rent.** The solver's `Chain` gains an optional way to read the rent sysvar. The CLI chain the solver runs on provides it through the client's `rentSysvar`. `createdRent` and the fill check price each opened token account as floor((128 + space) × perByteYear × threshold), with the same 696 to 6,960 bounds and refusal messages as the CLI's `rentRate`. The rate is read once per run.
2. **No silent constant.** If a chain cannot report rent, the solver keeps the current 6,960 pricing. This is the conservative upper bound: it can only skip more fills, never take a fill over the cap. `rentExempt(space)` stays exported with its current result, and a variant takes the rent values.
3. **Reports.** The `rent` in filled, sent and skipped entries is the live amount.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Keep public exports backward compatible.
- Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show, with values written out by hand:
   - a 165-byte account at 5,080 costs 1,488,440, and at 3,387 × 1.5 it costs 1,488,586;
   - a fill whose rent is over `maxRent` at 6,960 but under it at 5,080 is taken on a 5,080 chain;
   - out-of-range rates are refused;
   - a chain without rent support still prices at 6,960.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
